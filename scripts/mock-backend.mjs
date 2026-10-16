/**
 * Mock AUMS backend for end-to-end UI verification (dev only).
 * Serves the same shapes as backend/server.js on :3001.
 * Run: node scripts/mock-backend.mjs  → then: npm run dev (frontend, port 5173)
 */
import express from 'express';

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', '*');
  res.set('Access-Control-Allow-Methods', '*');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const SESSIONS = new Set();

app.post('/login', async (req, res) => {
  await delay(400);
  if (req.body.username === 'bad') {
    return res.status(401).json({ success: false, code: 'INVALID_CREDENTIALS', error: 'Invalid username or password.' });
  }
  const sessionId = 'mock-' + Math.random().toString(36).slice(2, 10);
  SESSIONS.add(sessionId);
  res.json({ success: true, sessionId });
});

app.post('/logout', (req, res) => res.json({ success: true }));

app.get('/profile', async (req, res) => {
  await delay(150);
  if (!SESSIONS.has(req.headers['x-session-id'])) {
    return res.status(401).json({ success: false, code: 'SESSION_EXPIRED', error: 'Session expired' });
  }
  res.json({
    success: true,
    name: 'Sample Student',
    rollNumber: 'CB.EN.U4CSE25011',
    registrationNumber: 'RA2511003010001',
    programme: 'B.Tech',
    branch: 'Computer Science and Engineering',
    semester: '8',
    batch: '2025',
    section: 'A',
    campus: 'Chennai',
    email: 'student@example.edu',
    phone: '9876543210',
    mentor: 'Dr. Mock Mentor',
    photo: '',
  });
});

const SEMESTERS = [
  { id: '719', name: '1' }, { id: '720', name: '2' }, { id: '721', name: '3' },
  { id: '722', name: '4' }, { id: '723', name: '5' }, { id: '724', name: '6' },
  { id: '725', name: '7' }, { id: '726', name: '8' },
];
// Current semester 8 (batch 2021 → Oct 2026), consistent with /profile and /gpa.
const CURRENT_SEM_ID = '726';

app.get('/attendance', async (req, res) => {
  await delay(200);
  if (!SESSIONS.has(req.headers['x-session-id'])) {
    return res.status(401).json({ success: false, code: 'SESSION_EXPIRED', error: 'Session expired' });
  }
  res.json({ success: true, semesters: SEMESTERS });
});

const SUBJECTS = [
  { courseId: 'c1', courseCode: 'CS3021', name: 'Compiler Design', totalClasses: 42, attendedClasses: 29, attendance: 69.0 },
  { courseId: 'c2', courseCode: 'CS3051', name: 'Computer Networks', totalClasses: 40, attendedClasses: 35, attendance: 87.5 },
  { courseId: 'c3', courseCode: 'MA2011', name: 'Probability and Statistics', totalClasses: 36, attendedClasses: 31, attendance: 86.1 },
  { courseId: 'c4', courseCode: 'CS3003', name: 'Software Engineering', totalClasses: 30, attendedClasses: 27, attendance: 90.0 },
  { courseId: 'c5', courseCode: 'CS3991', name: 'Industrial Internship', totalClasses: 0, attendedClasses: 0, attendance: 0 },
];

app.post('/attendance/report', async (req, res) => {
  await delay(300);
  if (!SESSIONS.has(req.headers['x-session-id'])) {
    return res.status(401).json({ success: false, code: 'SESSION_EXPIRED', error: 'Session expired' });
  }
  res.json({ success: true, semester: '8', subjects: SUBJECTS });
});

// Deterministic per-course event history for calendar + modal.
app.post('/attendance/course', async (req, res) => {
  await delay(120);
  if (!SESSIONS.has(req.headers['x-session-id'])) {
    return res.status(401).json({ success: false, code: 'SESSION_EXPIRED', error: 'Session expired' });
  }
  const { courseId } = req.body;
  const subject = SUBJECTS.find((s) => s.courseId === courseId);
  if (!subject) return res.status(400).json({ success: false, code: 'INTERNAL_ERROR', error: 'Course ID required' });

  const events = [];
  const today = new Date();
  for (let i = 20; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dow = d.getDay();
    if (dow === 0 || dow === 6) continue; // weekends off
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    // Pattern: mostly present; course c1 (low attendance) misses more.
    const missMod = courseId === 'c1' ? 4 : courseId === 'c2' ? 9 : 7;
    const status = i % missMod === 0 ? 'Absent' : i % 11 === 0 ? 'OD' : 'Present';
    events.push({ date: iso, period: 1 + (i % 4), status, subjectCode: subject.courseCode, hours: 1 });
  }
  const present = events.filter((e) => e.status === 'Present' || e.status === 'OD').length;
  const absent = events.filter((e) => e.status === 'Absent').length;
  const total = events.length;
  res.json({
    success: true,
    subject: { code: subject.courseCode, name: subject.name, percentage: subject.attendance },
    stats: { total, present, absent, od: 0, percentage: total ? Math.round((present / total) * 1000) / 10 : 0 },
    events,
  });
});

app.get('/course-attendance/pdf', (req, res) => res.status(404).json({ success: false, error: 'PDF not found' }));

app.get('/gpa', async (req, res) => {
  await delay(250);
  if (!SESSIONS.has(req.headers['x-session-id'])) {
    return res.status(401).json({ success: false, code: 'SESSION_EXPIRED', error: 'Session expired' });
  }
  const semester = parseInt(req.query.semester) || 1;
  const bySem = {
    5: { sgpa: '8.72', cgpa: '8.41', grades: [
      { semester: '5', courseCode: 'CS3021', courseName: 'Compiler Design', academicTermPeriod: '2024-25 ODD', type: 'Theory', grade: 'A' },
      { semester: '5', courseCode: 'CS3051', courseName: 'Computer Networks', academicTermPeriod: '2024-25 ODD', type: 'Theory', grade: 'A+' },
      { semester: '5', courseCode: 'MA2011', courseName: 'Probability and Statistics', academicTermPeriod: '2024-25 ODD', type: 'Theory', grade: 'B+' },
      { semester: '5', courseCode: 'CS3003', courseName: 'Software Engineering', academicTermPeriod: '2024-25 ODD', type: 'Theory', grade: 'O' },
      { semester: '5', courseCode: 'CS3991', courseName: 'Industrial Internship', academicTermPeriod: '2024-25 ODD', type: 'Internship', grade: 'P' },
    ] },
    8: { sgpa: '7.50', cgpa: '8.41', grades: [
      { semester: '8', courseCode: 'CS3021', courseName: 'Compiler Design', academicTermPeriod: '2026-27 ODD', type: 'Theory', grade: 'B' },
      { semester: '8', courseCode: 'CS3051', courseName: 'Computer Networks', academicTermPeriod: '2026-27 ODD', type: 'Theory', grade: 'A' },
      { semester: '8', courseCode: 'MA2011', courseName: 'Probability and Statistics', academicTermPeriod: '2026-27 ODD', type: 'Theory', grade: 'A' },
      { semester: '8', courseCode: 'CS3003', courseName: 'Software Engineering', academicTermPeriod: '2026-27 ODD', type: 'Theory', grade: 'A+' },
    ] },
  };
  const entry = bySem[semester] || { sgpa: String(7.5 + (semester % 4) * 0.3), cgpa: '8.41', grades: [] };
  res.json({ success: true, currentCgpa: entry.cgpa, semesterSgpa: entry.sgpa, semester: String(semester), grades: entry.grades });
});

// --- Published marks (same shape as GET /marks on server.js) --------------
const MARK_COURSES = ['CS3021', 'CS3051', 'MA2011', 'CS3003', 'CS3991'];
const MARK_EXAMS = [
  { name: 'IA 1', period: '2026-27 ODD', type: 'Regular' },
  { name: 'IA 2', period: '2026-27 ODD', type: 'Regular' },
  { name: 'Assignment', period: '2026-27 ODD', type: 'Assignment' },
  { name: 'SEE', period: '2026-27 ODD', type: 'University' },
];
const MARK_SEMESTERS = Array.from({ length: 8 }, (_, i) => ({ id: String(717 + i), name: String(i + 1) }));

app.get('/marks', async (req, res) => {
  await delay(180);
  if (!SESSIONS.has(req.headers['x-session-id'])) {
    return res.status(401).json({ success: false, code: 'SESSION_EXPIRED', error: 'Session expired' });
  }
  const semester = parseInt(req.query.semester) || 1;
  // Deterministic matrix with a realistic mix of published / NP / blank cells.
  const exams = MARK_EXAMS.map((e, ei) => {
    const marks = {};
    MARK_COURSES.forEach((c, ci) => {
      if (e.name === 'SEE') {
        marks[c] = semester >= 7 ? 'NP' : 55 + ((semester * 3 + ci * 7) % 36);
      } else if ((ci + ei + semester) % 7 === 0) {
        marks[c] = 'NP'; // not published yet
      } else if ((ci * 3 + ei + semester) % 11 === 0) {
        marks[c] = null; // component not applicable
      } else {
        marks[c] = ((semester + ei * 2 + ci) % 16) + 4; // 4..19 / 20
      }
    });
    return { ...e, marks };
  });
  res.json({
    success: true,
    semester: String(semester),
    semesters: MARK_SEMESTERS,
    courses: MARK_COURSES,
    exams,
  });
});

const PORT = process.env.MOCK_PORT || 3002;
app.listen(PORT, () => console.log(`Mock AUMS backend on :${PORT}`));
