import express from 'express';
import cors from 'cors';
import { login } from './browser/login.js';
import { fetchProfile } from './browser/profile.js';
import { fetchGPA } from './browser/gpa.js';
import { getAttendanceSemesters, getAttendanceReport } from './services/attendanceService.js';
import { getCourseAttendance } from './services/courseAttendanceService.js';
import { cacheService, cacheKeys, PROFILE_TTL_MS } from './services/cacheService.js';
import { withTiming } from './services/timing.js';
import { inspectPageState, recoverAumsSession, reloginInContext, performAumsLogout } from './browser/pageState.js';
import { getBrowser } from './browser/browser.js';

const app = express();
app.use(cors());
app.use(express.json());

// PORT can be set to "0", "" or garbage in some shells; fall back to 3001
// unless it's a real positive port number.
const PORT = (() => {
  const n = parseInt(process.env.PORT, 10);
  return Number.isInteger(n) && n > 0 ? n : 3001;
})();

const sessions = new Map();
const SESSION_TIMEOUT_MS = 30 * 60 * 1000;

// Window in which a returning user whose AUMS/CAS session died is
// transparently re-authenticated inside their existing Playwright context.
const RECOVERY_RELOGIN_WINDOW_MS = 12 * 60 * 60 * 1000;
// Cooldown between re-login attempts (avoids CAS lockout loops if the
// password changed elsewhere).
const RELOGIN_COOLDOWN_MS = 30 * 1000;

// AUMS-side session death surfaces as frame/menu-detection failures inside the
// browser modules (they return { success:false, error } instead of throwing).
const SESSION_LOST_RESULT_PATTERNS = [
  'menu item not found',
  'menu not found',
  'frame not found',
  'frame lost',
];

function looksLikeSessionLost(result) {
  if (!result || typeof result !== 'object' || result.success !== false) return false;
  const msg = String(result.error || '').toLowerCase();
  return SESSION_LOST_RESULT_PATTERNS.some((p) => msg.includes(p));
}

// Transient Playwright frame errors: the AUMS landing can still be building
// its own frames right after login and clobber a data navigation, detaching
// the frame mid-operation. A short pause + one retry resolves it — the
// session itself is fine.
const TRANSIENT_FRAME_ERROR_PATTERNS = ['frame was detached', 'execution context was destroyed', 'target closed'];

function isTransientFrameError(result) {
  if (!result || typeof result !== 'object' || result.success !== false) return false;
  const msg = String(result.error || '').toLowerCase();
  return TRANSIENT_FRAME_ERROR_PATTERNS.some((p) => msg.includes(p));
}

function cleanupExpiredSessions() {
  const now = Date.now();
  for (const [id, session] of sessions.entries()) {
    if (now - session.lastActivity > SESSION_TIMEOUT_MS) {
      console.log(`Session ${id.substring(0, 6)}... expired, cleaning up`);
      session.context.close().catch(() => {});
      cacheService.invalidateSession(id);
      sessions.delete(id);
    }
  }
}

setInterval(cleanupExpiredSessions, 5 * 60 * 1000);

function updateSessionActivity(sessionId) {
  const session = sessions.get(sessionId);
  if (session) session.lastActivity = Date.now();
}

async function closeSession(sessionId, { performAumsLogout: doAumsLogout = false } = {}) {
  const session = sessions.get(sessionId);
  if (session) {
    sessions.delete(sessionId);
    cacheService.invalidateSession(sessionId);
    if (doAumsLogout) {
      // Tell AUMS/CAS we are leaving so server-side session state is really
      // destroyed (the HAR shows the real chain: /aums/logout.jsp ->
      // /portal/logout -> /cas/logout). Bounded and best-effort.
      await performAumsLogout(session.page).catch(() => {});
    }
    await session.context.close().catch(() => {});
  }
}

function enqueueSessionOperation(session, operation) {
  const run = session.operationQueue.then(operation);
  session.operationQueue = run.catch(() => {});
  return run;
}

// Recover the shared page after AUMS/CAS killed the session.
// Order: 1) transparent CAS-SSO recovery with existing cookies (no creds),
// 2) silent re-login inside the same context when we still hold fresh
// credentials, 3) clean SESSION_EXPIRED so the frontend shows the login form
// instead of a glitch.
async function recoverSession(session) {
  const log = (m) => console.log(`[RECOVERY] ${String(session.id).substring(0, 8)} ${m}`);
  const state = await inspectPageState(session.page);
  if (state === 'aums') return;
  if (state === 'unknown') {
    // Could be mid-navigation from a previous op — settle briefly and recheck.
    await new Promise((r) => setTimeout(r, 800));
    const again = await inspectPageState(session.page);
    if (again === 'aums') return;
    if (again !== 'cas-logout' && again !== 'cas-login') {
      // Genuinely unknown state — let the operation fail naturally.
      return;
    }
  }

  const outcome = await recoverAumsSession(session.page, log);
  if (outcome === 'recovered') {
    log('AUMS session re-established via CAS SSO');
    return;
  }

  // SSO did not work — try silent re-login with stored credentials.
  const now = Date.now();
  const credsFresh = session.credentials && (now - session.credentialsAt) < RECOVERY_RELOGIN_WINDOW_MS;
  const cooledDown = (now - (session.relogin?.lastAttempt || 0)) > RELOGIN_COOLDOWN_MS;
  if (outcome === 'needs-login' && credsFresh && cooledDown) {
    session.relogin = session.relogin || { lastAttempt: 0 };
    session.relogin.lastAttempt = now;
    log('SSO recovery unavailable — re-authenticating in existing context');
    const result = await reloginInContext(session.context, session.credentials.username, session.credentials.password, log);
    if (result.success && result.page && !result.page.isClosed()) {
      try { await session.page.close(); } catch { /* old page already gone */ }
      session.page = result.page; // session keeps its context; page swapped
      log('Re-login successful — session restored');
      return;
    }
    if (result.code === 'INVALID_CREDENTIALS') {
      // Do not retry-loop against CAS with bad credentials.
      const err = new Error('AUMS session expired. Please sign in again.');
      err.code = 'SESSION_EXPIRED';
      throw err;
    }
  }

  const err = new Error('AUMS session expired. Please sign in again.');
  err.code = 'SESSION_EXPIRED';
  throw err;
}

// Guard + auto-recovery wrapper around every session operation.
// - Pre-check: if the page sits on a CAS login/logout page, recover BEFORE
//   running the operation (this is the "stuck on logout page" fix).
// - Post-check: when an operation reports a session-lost-shaped failure and
//   the page really is logged out, recover once and retry the operation once.
async function ensureAumsReady(session, operation) {
  const attempt = async () => {
    const state = await inspectPageState(session.page);
    if (state === 'cas-logout' || state === 'cas-login') {
      await recoverSession(session);
    } else if (state === 'unknown') {
      await new Promise((r) => setTimeout(r, 500));
      const again = await inspectPageState(session.page);
      if (again === 'cas-logout' || again === 'cas-login') {
        await recoverSession(session);
      }
    }

    let result = await operation();

    if (isTransientFrameError(result)) {
      // Landing still settling — pause briefly and retry once.
      await new Promise((r) => setTimeout(r, 1500));
      result = await operation();
    }

    if (looksLikeSessionLost(result)) {
      const st = await inspectPageState(session.page);
      if (st === 'cas-logout' || st === 'cas-login') {
        await recoverSession(session);
        return await operation();
      }
      // AUMS is fine — the failure was something else; return it untouched.
    }
    return result;
  };

  try {
    return await attempt();
  } catch (error) {
    // Session-expiry errors thrown by recoverSession propagate unchanged so
    // routes can map them to a clean 401 SESSION_EXPIRED.
    throw error;
  }
}

function generateSessionId() {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

// Helper: wrap an operation with a timeout
function withTimeout(promise, ms, errorMessage) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(errorMessage)), ms)
    )
  ]);
}

// POST /login — 90s timeout (AUMS can be slow)
app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ success: false, code: 'INVALID_CREDENTIALS', error: 'Username and password required' });

  try {
    const result = await withTimeout(
      login(username, password),
      90000,
      'AUMS is taking too long to respond. Please try again.'
    );

    if (result.success) {
      const sessionId = generateSessionId();
      sessions.set(sessionId, {
        id: sessionId,
        context: result.context,
        page: result.page,
        httpClient: result.httpClient,
        createdAt: Date.now(),
        lastActivity: Date.now(),
        operationQueue: Promise.resolve(),
        // Held ONLY in server memory to enable transparent re-login on
        // session recovery. Never logged, never cached, never sent anywhere.
        credentials: { username, password },
        credentialsAt: Date.now(),
        relogin: { lastAttempt: 0 },
      });
      res.json({ success: true, sessionId });
    } else {
      if (result.context) await result.context.close().catch(() => {});
      // Pass through the specific error message from login.js
      res.status(401).json({ success: false, code: result.code || 'INVALID_CREDENTIALS', error: result.error || 'Login failed' });
    }
  } catch (error) {
    console.error('Login error:', error.message);
    // Distinguish between timeout and other errors
    if (error.message.includes('too long') || error.message.includes('timeout')) {
      res.status(504).json({ success: false, code: 'AUMS_TIMEOUT', error: 'AUMS is taking too long to respond. Please try again.' });
    } else {
      res.status(500).json({ success: false, code: 'INTERNAL_ERROR', error: 'Login failed. Please try again.' });
    }
  }
});

// POST /logout
// POST /logout — performs a real AUMS/CAS logout (so AUMS server-side state
// and the CAS SSO cookie are properly invalidated) before destroying the
// Playwright context.
app.post('/logout', async (req, res) => {
  const sessionId = req.headers['x-session-id'];
  if (sessionId) await closeSession(sessionId, { performAumsLogout: true });
  res.json({ success: true });
});

// GET /profile — 60s timeout
app.get('/profile', async (req, res) => {
  const sessionId = req.headers['x-session-id'];
  if (!sessionId) return res.status(401).json({ success: false, code: 'SESSION_EXPIRED', error: 'No session provided' });
  updateSessionActivity(sessionId);
  try {
    const session = sessions.get(sessionId);
    if (!session) return res.status(401).json({ success: false, code: 'SESSION_EXPIRED', error: 'Session expired' });

    const cached = cacheService.get(sessionId, cacheKeys.profile(sessionId));
    if (cached !== undefined) return res.json(cached);

    const result = await withTimeout(
      enqueueSessionOperation(session, () =>
        withTiming('profile', sessionId, () =>
          ensureAumsReady(session, () =>
            fetchProfile(session.page, session.context)
          ), (r) => ({ success: !!(r && r.success) }))
      ),
      60000,
      'AUMS is taking too long to respond.'
    );

    if (result && result.success) {
      cacheService.set(sessionId, cacheKeys.profile(sessionId), result, PROFILE_TTL_MS);
    }
    res.json(result);
  } catch (error) {
    console.error('Profile fetch error:', error.message);
    const profileCode = error.message?.includes('taking too long') ? 'AUMS_TIMEOUT' : 'PLAYWRIGHT_ERROR';
    const profileStatus = profileCode === 'AUMS_TIMEOUT' ? 504 : 500;
    res.status(profileStatus).json({ success: false, code: profileCode, error: 'Failed to fetch profile' });
  }
});

// GET /attendance - semesters — 60s timeout
app.get('/attendance', async (req, res) => {
  const sessionId = req.headers['x-session-id'];
  if (!sessionId) return res.status(401).json({ success: false, code: 'SESSION_EXPIRED', error: 'No session provided' });
  updateSessionActivity(sessionId);
  try {
    const session = sessions.get(sessionId);
    if (!session) return res.status(401).json({ success: false, code: 'SESSION_EXPIRED', error: 'Session expired' });

    const result = await withTimeout(
      enqueueSessionOperation(session, () =>
        withTiming('attendance_semesters', sessionId, () =>
          ensureAumsReady(session, () =>
            cacheService.getOrFetch(sessionId, cacheKeys.semesters(sessionId), () =>
              getAttendanceSemesters(session.page)
            )
          ), (r) => ({ success: !!(r && r.success), semesters: (r && r.semesters && r.semesters.length) || 0 }))
      ),
      60000,
      'AUMS is taking too long to respond.'
    );
    res.json(result);
  } catch (error) {
    console.error('Attendance semesters fetch error:', error.message);
    const attSemCode = error.message?.includes('taking too long') ? 'AUMS_TIMEOUT' : 'PLAYWRIGHT_ERROR';
    const attSemStatus = attSemCode === 'AUMS_TIMEOUT' ? 504 : 500;
    res.status(attSemStatus).json({ success: false, code: attSemCode, error: 'Failed to fetch attendance semesters' });
  }
});

// POST /attendance/report — 60s timeout
app.post('/attendance/report', async (req, res) => {
  const sessionId = req.headers['x-session-id'];
  const semesterId = req.body.semesterId;
  if (!sessionId) return res.status(401).json({ success: false, code: 'SESSION_EXPIRED', error: 'No session provided' });
  updateSessionActivity(sessionId);
  if (!semesterId) return res.status(400).json({ success: false, code: 'INTERNAL_ERROR', error: 'Semester ID required' });
  try {
    const session = sessions.get(sessionId);
    if (!session) return res.status(401).json({ success: false, code: 'SESSION_EXPIRED', error: 'Session expired' });

    const result = await withTimeout(
      enqueueSessionOperation(session, () =>
        withTiming('attendance_report', sessionId, () =>
          ensureAumsReady(session, () =>
            cacheService.getOrFetch(sessionId, cacheKeys.attendanceReport(sessionId, semesterId), () =>
              getAttendanceReport(session.page, semesterId)
            )
          ), (r) => ({ success: !!(r && r.success), subjects: (r && r.subjects && r.subjects.length) || 0 }))
      ),
      60000,
      'AUMS is taking too long to respond.'
    );
    res.json(result);
  } catch (error) {
    console.error('Attendance report fetch error:', error.message);
    const attRepCode = error.message?.includes('taking too long') ? 'AUMS_TIMEOUT' : 'PLAYWRIGHT_ERROR';
    const attRepStatus = attRepCode === 'AUMS_TIMEOUT' ? 504 : 500;
    res.status(attRepStatus).json({ success: false, code: attRepCode, error: 'Failed to fetch attendance report' });
  }
});

// POST /attendance/course — 60s timeout
app.post('/attendance/course', async (req, res) => {
  const sessionId = req.headers['x-session-id'];
  const { semesterId, courseId } = req.body;
  if (!sessionId) return res.status(401).json({ success: false, code: 'SESSION_EXPIRED', error: 'No session provided' });
  updateSessionActivity(sessionId);
  if (!courseId) return res.status(400).json({ success: false, code: 'INTERNAL_ERROR', error: 'Course ID required' });
  try {
    const session = sessions.get(sessionId);
    if (!session) return res.status(401).json({ success: false, code: 'SESSION_EXPIRED', error: 'Session expired' });

    const result = await withTimeout(
      enqueueSessionOperation(session, () =>
        withTiming('course_attendance', sessionId, () =>
          ensureAumsReady(session, () =>
            cacheService.getOrFetch(sessionId, cacheKeys.courseAttendance(sessionId, semesterId, courseId), () =>
              getCourseAttendance(session.page, semesterId, courseId)
            )
          ), (r) => ({ success: !!(r && r.success), events: (r && r.events && r.events.length) || 0 }))
      ),
      90000,
      'AUMS is taking too long to respond.'
    );
    res.json(result);
  } catch (error) {
    console.error('Course attendance fetch error:', error.message);
    const courseCode = error.message?.includes('taking too long') ? 'AUMS_TIMEOUT' : 'PLAYWRIGHT_ERROR';
    const courseStatus = courseCode === 'AUMS_TIMEOUT' ? 504 : 500;
    res.status(courseStatus).json({ success: false, code: courseCode, error: 'Failed to fetch course attendance' });
  }
});

// GET /course-attendance/pdf — 90s timeout
app.get('/course-attendance/pdf', async (req, res) => {
  const sessionId = req.headers['x-session-id'];
  const semesterId = req.query.semesterId;
  const courseId = req.query.courseId;
  if (!sessionId) return res.status(401).json({ success: false, code: 'SESSION_EXPIRED', error: 'No session provided' });
  updateSessionActivity(sessionId);
  if (!courseId) return res.status(400).json({ success: false, error: 'Course ID required' });
  try {
    const session = sessions.get(sessionId);
    if (!session) return res.status(401).json({ success: false, code: 'SESSION_EXPIRED', error: 'Session expired' });

    // Served from the same per-session cache as POST /attendance/course — no
    // duplicate AUMS/PDF work when the JSON call already ran.
    const result = await withTimeout(
      enqueueSessionOperation(session, () =>
        withTiming('course_pdf', sessionId, () =>
          ensureAumsReady(session, () =>
            cacheService.getOrFetch(sessionId, cacheKeys.courseAttendance(sessionId, semesterId, courseId), () =>
              getCourseAttendance(session.page, semesterId, courseId)
            )
          ), (r) => ({ success: !!(r && r.success), hasPdf: !!(r && r.rawPdfBase64) }))
      ),
      90000,
      'AUMS is taking too long to respond.'
    );

    if (result.success && result.rawPdfBase64) {
      res.contentType('application/pdf');
      res.send(Buffer.from(result.rawPdfBase64, 'base64'));
    } else {
      res.status(404).json({ success: false, code: 'INTERNAL_ERROR', error: 'PDF not found' });
    }
  } catch (error) {
    console.error('PDF fetch error:', error.message);
    const pdfCode = error.message?.includes('taking too long') ? 'AUMS_TIMEOUT' : 'PLAYWRIGHT_ERROR';
    const pdfStatus = pdfCode === 'AUMS_TIMEOUT' ? 504 : 500;
    res.status(pdfStatus).json({ success: false, code: pdfCode, error: 'Failed to fetch PDF' });
  }
});

// GET /gpa — 60s timeout
app.get('/gpa', async (req, res) => {
  const sessionId = req.headers['x-session-id'];
  if (!sessionId) return res.status(401).json({ success: false, code: 'SESSION_EXPIRED', error: 'No session provided' });
  updateSessionActivity(sessionId);
  try {
    const session = sessions.get(sessionId);
    if (!session) return res.status(401).json({ success: false, code: 'SESSION_EXPIRED', error: 'Session expired' });
    const semester = parseInt(req.query.semester) || 1;
    const result = await withTimeout(
      enqueueSessionOperation(session, () =>
        withTiming('gpa', sessionId, () =>
          ensureAumsReady(session, () =>
            cacheService.getOrFetch(sessionId, cacheKeys.gpa(sessionId, semester), () =>
              fetchGPA(session.page, semester)
            )
          ), (r) => ({ success: !!(r && r.success), grades: (r && r.grades && r.grades.length) || 0 }))
      ),
      60000,
      'AUMS is taking too long to respond.'
    );
    res.json(result);
  } catch (error) {
    console.error('GPA fetch error:', error.message);
    const gpaCode = error.message?.includes('taking too long') ? 'AUMS_TIMEOUT' : 'PLAYWRIGHT_ERROR';
    const gpaStatus = gpaCode === 'AUMS_TIMEOUT' ? 504 : 500;
    res.status(gpaStatus).json({ success: false, code: gpaCode, error: 'Failed to fetch GPA data' });
  }
});

process.on('SIGINT', async () => {
  console.log('Shutting down...');
  for (const [, session] of sessions.entries()) {
    await session.context.close().catch(() => {});
  }
  sessions.clear();
  cacheService.clearAll();
  process.exit(0);
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  // Warm the shared Chromium at boot so the first login doesn't pay the
  // cold-launch cost (~1-3s). Best-effort: login launches its own browser
  // lazily if this fails.
  getBrowser()
    .then(() => console.log('[BOOT] Chromium warm'))
    .catch((e) => console.warn('[BOOT] Browser warmup failed:', e.message));
});
