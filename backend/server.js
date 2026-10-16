import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { login, httpLoginOnly } from './browser/login.js';
import { getAttendanceSemestersHttp, getAttendanceReportHttp, getCourseAttendanceHttp, getGpaHttp, getMarksHttp, getProfileHttp } from './services/aumsHttp.js';
import { cacheService, cacheKeys, PROFILE_TTL_MS } from './services/cacheService.js';
import { withTiming } from './services/timing.js';
// Playwright-backed modules load lazily — see browser/runtime.js. The default
// HTTP path never imports `playwright` and never launches Chromium.
import { loadBrowserRuntime } from './browser/runtime.js';

const app = express();
app.use(cors());
app.use(express.json());

// PORT can be set to "0", "" or garbage in some shells; fall back to 3001
// unless it's a real positive port number. Render (and every other PaaS)
// injects its own assigned PORT — honor it.
const PORT = (() => {
  const n = parseInt(process.env.PORT, 10);
  return Number.isInteger(n) && n > 0 ? n : 3001;
})();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Overridable so the combined-deployment tests can point at a fixture build;
// production always serves the real Vite output.
const FRONTEND_DIST = process.env.FRONTEND_DIST || path.join(__dirname, '..', 'frontend', 'dist');

// Liveness endpoint for the platform health check (Render polls /health).
app.get('/health', (_req, res) => res.status(200).send('ok'));

// All API routes live on one router mounted at BOTH the root (legacy dev
// paths, existing tests) and /api (what the production frontend build calls
// — see frontend/src/lib/api.ts, API_BASE="/api"). One definition, two
// prefixes; the app works identically as a split dev setup or a combined
// single-origin deployment.
const api = express.Router();
app.use('/', api);
app.use('/api', api);
// Anything under /api that no route matched is a JSON 404 — never the SPA
// fallback (an API typo must not return index.html with a 200).
app.use('/api', (_req, res) => {
  res.status(404).json({ success: false, code: 'NOT_FOUND', error: 'Not found' });
});

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
      if (session.context) session.context.close().catch(() => {});
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
      if (session.mode === 'http' && session.httpClient) {
        await session.httpClient.get('https://aumscn.amrita.edu/aums/logout.jsp').catch(() => {});
        await session.httpClient.get('https://aumscn.amrita.edu/cas/logout').catch(() => {});
      } else if (session.page) {
        const { performAumsLogout } = await loadBrowserRuntime();
        await performAumsLogout(session.page).catch(() => {});
      }
    }
    if (session.context) await session.context.close().catch(() => {});
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
  const { inspectPageState, recoverAumsSession, reloginInContext } = await loadBrowserRuntime();
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
    const { inspectPageState } = await loadBrowserRuntime();
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

// HTTP-first data access. Sessions created by the plain-HTTP CAS login carry
// only a per-user cookie jar (no Playwright page) and run every data fetch as
// direct axios requests; browser-fallback sessions keep the frame-based flow
// with auto-recovery. Both paths return identical payload shapes.
//
// HTTP sessions also self-heal: when AUMS reports the CAS login page (session
// expired), we silently re-login over HTTP with the in-memory credentials and
// retry the operation once — no browser involved, no user-visible glitch.
const HTTP_RELOGIN_COOLDOWN_MS = 30 * 1000;
const HTTP_RELOGIN_WINDOW_MS = 12 * 60 * 60 * 1000;

async function runHttpWithRecovery(session, operation) {
  try {
    return await operation();
  } catch (error) {
    if (!isSessionExpiredError(error)) throw error;
    if (!session.credentials) throw error;

    const now = Date.now();
    const fresh = now - session.credentialsAt < HTTP_RELOGIN_WINDOW_MS;
    const cooledDown = now - (session.httpRelogin?.lastAttempt || 0) > HTTP_RELOGIN_COOLDOWN_MS;
    if (!fresh || !cooledDown) throw error;

    session.httpRelogin = { lastAttempt: now };
    console.log(`[RECOVERY] ${String(session.id).substring(0, 8)} HTTP session expired — silent re-login`);
    try {
      const { httpClient } = await httpLoginOnly(session.credentials.username, session.credentials.password);
      session.httpClient = httpClient;
    } catch (reloginError) {
      console.error(`[RECOVERY] ${String(session.id).substring(0, 8)} silent re-login failed: ${reloginError.message}`);
      throw error; // original SESSION_EXPIRED — frontend shows the login form
    }
    return operation();
  }
}

function withAumsData(session, httpOperation, browserOperation) {
  if (session.mode === 'http') return runHttpWithRecovery(session, httpOperation);
  return ensureAumsReady(session, browserOperation);
}

// HTTP sessions signal upstream expiry by throwing { code: 'SESSION_EXPIRED' }.
function isSessionExpiredError(error) {
  return !!(error && error.code === 'SESSION_EXPIRED');
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
api.post('/login', async (req, res) => {
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
        // 'http' = cookie-jar-only session (Playwright-free data path);
        // 'browser' = fallback Playwright session with a page/context.
        mode: result.mode || 'browser',
        context: result.context || null,
        page: result.page || null,
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
      const status = result.code === 'AUMS_UNAVAILABLE' ? 503 : 401;
      res.status(status).json({ success: false, code: result.code || 'INVALID_CREDENTIALS', error: result.error || 'Login failed' });
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
api.post('/logout', async (req, res) => {
  const sessionId = req.headers['x-session-id'];
  if (sessionId) await closeSession(sessionId, { performAumsLogout: true });
  res.json({ success: true });
});

// GET /profile — 60s timeout
api.get('/profile', async (req, res) => {
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
          withAumsData(session,
            () => getProfileHttp(session.httpClient),
            async () => {
              const { fetchProfile } = await loadBrowserRuntime();
              return fetchProfile(session.page, session.context);
            }
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
    if (isSessionExpiredError(error)) {
      return res.status(401).json({ success: false, code: 'SESSION_EXPIRED', error: 'AUMS session expired. Please sign in again.' });
    }
    console.error('Profile fetch error:', error.message);
    const profileCode = error.message?.includes('taking too long') ? 'AUMS_TIMEOUT' : 'PLAYWRIGHT_ERROR';
    const profileStatus = profileCode === 'AUMS_TIMEOUT' ? 504 : 500;
    res.status(profileStatus).json({ success: false, code: profileCode, error: 'Failed to fetch profile' });
  }
});

// GET /attendance - semesters — 60s timeout
api.get('/attendance', async (req, res) => {
  const sessionId = req.headers['x-session-id'];
  if (!sessionId) return res.status(401).json({ success: false, code: 'SESSION_EXPIRED', error: 'No session provided' });
  updateSessionActivity(sessionId);
  try {
    const session = sessions.get(sessionId);
    if (!session) return res.status(401).json({ success: false, code: 'SESSION_EXPIRED', error: 'Session expired' });

    const result = await withTimeout(
      enqueueSessionOperation(session, () =>
        withTiming('attendance_semesters', sessionId, () =>
          withAumsData(session,
            () => cacheService.getOrFetch(sessionId, cacheKeys.semesters(sessionId), () =>
              getAttendanceSemestersHttp(session.httpClient)
            ),
            async () => {
              const { getAttendanceSemesters } = await loadBrowserRuntime();
              return cacheService.getOrFetch(sessionId, cacheKeys.semesters(sessionId), () =>
                getAttendanceSemesters(session.page)
              );
            }
          ), (r) => ({ success: !!(r && r.success), semesters: (r && r.semesters && r.semesters.length) || 0 }))
      ),
      60000,
      'AUMS is taking too long to respond.'
    );
    res.json(result);
  } catch (error) {
    if (isSessionExpiredError(error)) {
      return res.status(401).json({ success: false, code: 'SESSION_EXPIRED', error: 'AUMS session expired. Please sign in again.' });
    }
    console.error('Attendance semesters fetch error:', error.message);
    const attSemCode = error.message?.includes('taking too long') ? 'AUMS_TIMEOUT' : 'PLAYWRIGHT_ERROR';
    const attSemStatus = attSemCode === 'AUMS_TIMEOUT' ? 504 : 500;
    res.status(attSemStatus).json({ success: false, code: attSemCode, error: 'Failed to fetch attendance semesters' });
  }
});

// POST /attendance/report — 60s timeout
api.post('/attendance/report', async (req, res) => {
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
          withAumsData(session,
            () => cacheService.getOrFetch(sessionId, cacheKeys.attendanceReport(sessionId, semesterId), () =>
              getAttendanceReportHttp(session.httpClient, semesterId)
            ),
            async () => {
              const { getAttendanceReport } = await loadBrowserRuntime();
              return cacheService.getOrFetch(sessionId, cacheKeys.attendanceReport(sessionId, semesterId), () =>
                getAttendanceReport(session.page, semesterId)
              );
            }
          ), (r) => ({ success: !!(r && r.success), subjects: (r && r.subjects && r.subjects.length) || 0 }))
      ),
      60000,
      'AUMS is taking too long to respond.'
    );
    res.json(result);
  } catch (error) {
    if (isSessionExpiredError(error)) {
      return res.status(401).json({ success: false, code: 'SESSION_EXPIRED', error: 'AUMS session expired. Please sign in again.' });
    }
    console.error('Attendance report fetch error:', error.message);
    const attRepCode = error.message?.includes('taking too long') ? 'AUMS_TIMEOUT' : 'PLAYWRIGHT_ERROR';
    const attRepStatus = attRepCode === 'AUMS_TIMEOUT' ? 504 : 500;
    res.status(attRepStatus).json({ success: false, code: attRepCode, error: 'Failed to fetch attendance report' });
  }
});

// POST /attendance/course — 60s timeout
api.post('/attendance/course', async (req, res) => {
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
          withAumsData(session,
            () => cacheService.getOrFetch(sessionId, cacheKeys.courseAttendance(sessionId, semesterId, courseId), () =>
              getCourseAttendanceHttp(session.httpClient, semesterId, courseId)
            ),
            async () => {
              const { getCourseAttendance } = await loadBrowserRuntime();
              return cacheService.getOrFetch(sessionId, cacheKeys.courseAttendance(sessionId, semesterId, courseId), () =>
                getCourseAttendance(session.page, semesterId, courseId)
              );
            }
          ), (r) => ({ success: !!(r && r.success), events: (r && r.events && r.events.length) || 0 }))
      ),
      90000,
      'AUMS is taking too long to respond.'
    );
    res.json(result);
  } catch (error) {
    if (isSessionExpiredError(error)) {
      return res.status(401).json({ success: false, code: 'SESSION_EXPIRED', error: 'AUMS session expired. Please sign in again.' });
    }
    console.error('Course attendance fetch error:', error.message);
    const courseCode = error.message?.includes('taking too long') ? 'AUMS_TIMEOUT' : 'PLAYWRIGHT_ERROR';
    const courseStatus = courseCode === 'AUMS_TIMEOUT' ? 504 : 500;
    res.status(courseStatus).json({ success: false, code: courseCode, error: 'Failed to fetch course attendance' });
  }
});

// GET /course-attendance/pdf — 90s timeout
api.get('/course-attendance/pdf', async (req, res) => {
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
          withAumsData(session,
            () => cacheService.getOrFetch(sessionId, cacheKeys.courseAttendance(sessionId, semesterId, courseId), () =>
              getCourseAttendanceHttp(session.httpClient, semesterId, courseId)
            ),
            async () => {
              const { getCourseAttendance } = await loadBrowserRuntime();
              return cacheService.getOrFetch(sessionId, cacheKeys.courseAttendance(sessionId, semesterId, courseId), () =>
                getCourseAttendance(session.page, semesterId, courseId)
              );
            }
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
    if (isSessionExpiredError(error)) {
      return res.status(401).json({ success: false, code: 'SESSION_EXPIRED', error: 'AUMS session expired. Please sign in again.' });
    }
    console.error('PDF fetch error:', error.message);
    const pdfCode = error.message?.includes('taking too long') ? 'AUMS_TIMEOUT' : 'PLAYWRIGHT_ERROR';
    const pdfStatus = pdfCode === 'AUMS_TIMEOUT' ? 504 : 500;
    res.status(pdfStatus).json({ success: false, code: pdfCode, error: 'Failed to fetch PDF' });
  }
});

// GET /gpa — 60s timeout
api.get('/gpa', async (req, res) => {
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
          withAumsData(session,
            () => cacheService.getOrFetch(sessionId, cacheKeys.gpa(sessionId, semester), () =>
              getGpaHttp(session.httpClient, semester)
            ),
            async () => {
              const { fetchGPA } = await loadBrowserRuntime();
              return cacheService.getOrFetch(sessionId, cacheKeys.gpa(sessionId, semester), () =>
                fetchGPA(session.page, semester)
              );
            }
          ), (r) => ({ success: !!(r && r.success), grades: (r && r.grades && r.grades.length) || 0 }))
      ),
      60000,
      'AUMS is taking too long to respond.'
    );
    res.json(result);
  } catch (error) {
    if (isSessionExpiredError(error)) {
      return res.status(401).json({ success: false, code: 'SESSION_EXPIRED', error: 'AUMS session expired. Please sign in again.' });
    }
    console.error('GPA fetch error:', error.message);
    const gpaCode = error.message?.includes('taking too long') ? 'AUMS_TIMEOUT' : 'PLAYWRIGHT_ERROR';
    const gpaStatus = gpaCode === 'AUMS_TIMEOUT' ? 504 : 500;
    res.status(gpaStatus).json({ success: false, code: gpaCode, error: 'Failed to fetch GPA data' });
  }
});

// GET /marks?semester=N — published exam marks matrix (ViewPublishedMark.jsp).
// Same pre-rendered-semester fast path as /gpa: one INIT GET when AUMS already
// shows the requested semester, plus a SELSEM POST otherwise.
api.get('/marks', async (req, res) => {
  const sessionId = req.headers['x-session-id'];
  if (!sessionId) return res.status(401).json({ success: false, code: 'SESSION_EXPIRED', error: 'No session provided' });
  updateSessionActivity(sessionId);
  try {
    const session = sessions.get(sessionId);
    if (!session) return res.status(401).json({ success: false, code: 'SESSION_EXPIRED', error: 'Session expired' });
    const semester = parseInt(req.query.semester) || 1; // default: first semester
    const result = await withTimeout(
      enqueueSessionOperation(session, () =>
        withTiming('marks', sessionId, () =>
          withAumsData(session,
            () => cacheService.getOrFetch(sessionId, cacheKeys.marks(sessionId, semester), () =>
              getMarksHttp(session.httpClient, semester)
            ),
            async () => {
              const { fetchMarks } = await loadBrowserRuntime();
              return cacheService.getOrFetch(sessionId, cacheKeys.marks(sessionId, semester), () =>
                fetchMarks(session.page, semester)
              );
            }
          ), (r) => ({ success: !!(r && r.success), courses: (r && r.courses && r.courses.length) || 0, exams: (r && r.exams && r.exams.length) || 0 }))
      ),
      60000,
      'AUMS is taking too long to respond.'
    );
    res.json(result);
  } catch (error) {
    if (isSessionExpiredError(error)) {
      return res.status(401).json({ success: false, code: 'SESSION_EXPIRED', error: 'AUMS session expired. Please sign in again.' });
    }
    console.error('Marks fetch error:', error.message);
    const marksCode = error.message?.includes('taking too long') ? 'AUMS_TIMEOUT' : 'PLAYWRIGHT_ERROR';
    const marksStatus = marksCode === 'AUMS_TIMEOUT' ? 504 : 500;
    res.status(marksStatus).json({ success: false, code: marksCode, error: 'Failed to fetch marks data' });
  }
});

// Graceful shutdown for SIGINT (Ctrl+C) and SIGTERM (Render/PaaS stop signal):
// close sessions, flush caches, then close the HTTP server so in-flight
// requests finish within the platform's grace period.
async function shutdown(signal) {
  console.log(`${signal} received — shutting down...`);
  for (const [, session] of sessions.entries()) {
    if (session.context) await session.context.close().catch(() => {});
  }
  sessions.clear();
  cacheService.clearAll();
  server.close(() => process.exit(0));
  // Don't hang forever if a socket refuses to drain.
  setTimeout(() => process.exit(0), 8000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// --- Combined single-origin deployment -------------------------------------
// Serve the production-built frontend (frontend/dist) from the same Express
// app that serves the API. In dev, Vite runs separately against the root API
// paths; in production the frontend build calls API_BASE="/api" (see
// frontend/src/lib/api.ts) and every unknown non-API GET falls through to
// index.html (SPA fallback — the app is client-routed).
const DIST_INDEX = path.join(FRONTEND_DIST, 'index.html');
if (fs.existsSync(DIST_INDEX)) {
  // Hashed asset filenames are safe to cache hard; index.html must not be.
  app.use(express.static(FRONTEND_DIST, {
    index: false,
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
      // Match the dist-relative /assets/ segment on any OS (Windows paths
      // use backslashes, which a /\/assets\// regex would miss).
      else if (/[\\/]assets[\\/]/.test(filePath)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    },
  }));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path === '/health') return next();
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(DIST_INDEX);
  });
  console.log(`Serving frontend from ${FRONTEND_DIST}`);
}

// Bind all interfaces so the platform's router (Render) can reach us; the
// port always comes from the environment. No explicit host => dual-stack
// (IPv4 + IPv6): an explicit '0.0.0.0' silently breaks localhost over ::1,
// which some browsers try first.
const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  // No Chromium warm-up: Playwright is only imported/launched when a session
  // actually falls back to the browser (see browser/runtime.js).
});
