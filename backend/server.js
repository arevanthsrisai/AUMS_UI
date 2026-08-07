import express from 'express';
import cors from 'cors';
import { login } from './browser/login.js';
import { fetchProfile } from './browser/profile.js';
import { fetchGPA } from './browser/gpa.js';
import { getAttendanceSemesters, getAttendanceReport } from './services/attendanceService.js';
import { getCourseAttendance } from './services/courseAttendanceService.js';

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;

const sessions = new Map();
const SESSION_TIMEOUT_MS = 30 * 60 * 1000;

function cleanupExpiredSessions() {
  const now = Date.now();
  for (const [id, session] of sessions.entries()) {
    if (now - session.lastActivity > SESSION_TIMEOUT_MS) {
      console.log(`Session ${id.substring(0, 6)}... expired, cleaning up`);
      session.context.close().catch(() => {});
      sessions.delete(id);
    }
  }
}

setInterval(cleanupExpiredSessions, 5 * 60 * 1000);

function updateSessionActivity(sessionId) {
  const session = sessions.get(sessionId);
  if (session) session.lastActivity = Date.now();
}

async function closeSession(sessionId) {
  const session = sessions.get(sessionId);
  if (session) {
    sessions.delete(sessionId);
    await session.context.close().catch(() => {});
  }
}

function enqueueSessionOperation(session, operation) {
  const run = session.operationQueue.catch(() => {}).then(operation);
  session.operationQueue = run.catch(() => {});
  return run;
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
        context: result.context,
        page: result.page,
        httpClient: result.httpClient,
        createdAt: Date.now(),
        lastActivity: Date.now(),
        operationQueue: Promise.resolve()
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
app.post('/logout', async (req, res) => {
  const sessionId = req.headers['x-session-id'];
  if (sessionId) await closeSession(sessionId);
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
    const result = await withTimeout(
      enqueueSessionOperation(session, () => fetchProfile(session.page, session.context)),
      60000,
      'AUMS is taking too long to respond.'
    );
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
      enqueueSessionOperation(session, () => getAttendanceSemesters(session.page)),
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
      enqueueSessionOperation(session, () => getAttendanceReport(session.page, semesterId)),
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
      enqueueSessionOperation(session, () => getCourseAttendance(session.page, semesterId, courseId)),
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
    const result = await withTimeout(
      enqueueSessionOperation(session, () => getCourseAttendance(session.page, semesterId, courseId)),
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
      enqueueSessionOperation(session, () => fetchGPA(session.page, semester)),
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
  process.exit(0);
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
