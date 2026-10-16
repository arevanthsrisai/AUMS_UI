// Contract tests for the direct-HTTP AUMS stack (axios + manual cookie jar).
//
//   node --test backend/tests/test_http_client.mjs
//
// No AUMS credentials and no Playwright: every request runs against a local
// stub CAS + AUMS server built from real captured fixtures
// (tests/fixtures/attendance-report.html, profile.html, course-report.pdf).
//
// What this proves:
//   1. The whole login flow (CAS form -> credential POST -> redirect -> AUMS
//      landing) works over plain HTTP with zero browser involvement.
//   2. Attendance semesters / summary / course-PDF / GPA / profile flows send
//      the exact form payloads AUMS expects and parse the responses into the
//      same shapes the frontend already consumes.
//   3. An expired upstream session surfaces as SESSION_EXPIRED (HTTP 401).
//   4. The transport itself: per-hop cookie capture across redirects, binary
//      responses, per-session cookie isolation, and retry-with-backoff on 503.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';

import { AuthenticatedHttpClient } from '../services/httpClient.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = (name) => fs.readFileSync(path.join(here, 'fixtures', name));

const ATTENDANCE_HTML = fixtures('attendance-report.html').toString('utf8');
const PROFILE_HTML = fixtures('profile.html').toString('utf8');
const COURSE_PDF = fixtures('course-report.pdf');

const CAS_LOGIN_HTML = `<!DOCTYPE html><html><head><title>CAS Login</title></head><body>
<form action="/cas/login" method="post">
  <input type="hidden" name="execution" value="e1s1"/>
  <input type="hidden" name="_eventId" value="submit"/>
  <input type="hidden" name="geolocation" value=""/>
  <input type="text" name="username"/>
  <input type="password" name="password"/>
</form></body></html>`;

const CAS_ERROR_HTML = `<!DOCTYPE html><html><head><title>CAS Login</title></head><body>
<div class="errors">Invalid username or password.</div>
<form action="/cas/login" method="post">
  <input type="hidden" name="execution" value="e1s1"/>
  <input type="hidden" name="_eventId" value="submit"/>
  <input type="text" name="username"/>
  <input type="password" name="password"/>
</form></body></html>`;

const AUMS_LANDING_HTML = `<!DOCTYPE html><html><head><title>AUMS</title></head>
<frameset cols="20%,80%"><frame name="menu" src="menu.jsp"/><frame name="content" src="content.jsp"/></frameset>
</html>`;

const CAS_LOGIN_PAGE_HTML = `<!DOCTYPE html><html><head><title>CAS Login</title></head>
<body><form><input type="password" name="password"/></form></body></html>`;

// Course dropdown the real portal renders on the CHANGESEM response. The
// summary table in the fixture is "Semester 1" and contains course 23CSE102.
const COURSE_OPTIONS = [{ value: '107613', text: '23CSE102: Computer Hardware Essentials' }];

// Faithful to the live portal: the init + summary responses carry the dropdown
// for the DEFAULT-selected semester (Semester 1), NOT the requested one. These
// codes are present-but-unmatched for any other semester, which is exactly the
// regression the report flow must survive (course ids would otherwise be
// stripped and the calendar could not drill into a course).
const DEFAULT_SEM_COURSE_OPTIONS = [
  { value: '94346', text: '23CSE101: Computational Problem Solving' },
  { value: '94351', text: '23MAT107: Calculus' },
];

function withCourseOptions(html, options = COURSE_OPTIONS) {
  const $ = cheerio.load(html);
  const select = $('#htmlPageTopContainer_selectCourse');
  for (const opt of options) {
    select.append(`<option value="${opt.value}">${opt.text}</option>`);
  }
  return $.html();
}

function gpaHtml(selectedSemester) {
  const option = (value) => `<option value="10${value}"${String(selectedSemester) === String(value) ? ' selected' : ''}>${value}</option>`;
  return `<!DOCTYPE html><html><head><title>Student Performance With Survey</title></head><body>
<div id="htmlPageTopContainer">
  <label data-component="orphan-label">Current CGPA</label>
  <label data-component="orphan-label">8.42</label>
  <select id="htmlPageTopContainer_selectStep" name="htmlPageTopContainer_selectStep">
    ${option(1)}${option(2)}
  </select>
  <fieldset id="fieldset-Grades">
    <table>
      <tr><td>Sem</td><td>Code</td><td>Name</td><td>Term</td><td>Type</td><td>Grade</td></tr>
      <tr><td>1</td><td>23CSE101</td><td>Foundations of Computing</td><td>Jul 2025 - Dec 2025</td><td>SGPA</td><td>8.10</td></tr>
      <tr><td>1</td><td>23CSE102</td><td>Computer Hardware Essentials</td><td>Jul 2025 - Dec 2025</td><td>GRD</td><td>A</td></tr>
    </table>
  </fieldset>
</div></body></html>`;
}

// Published-marks matrix. Faithful to the live portal: INIT serves the
// "Select" placeholder + an EMPTY table; only a SELSEM POST carries marks.
// Semester ids match the real portal (717=1, 718=2, 719=3).
function marksHtml(selectedSemester) {
  const n = selectedSemester ? Number(selectedSemester) : null;
  const options = [1, 2, 3]
    .map((sem) => `<option value="71${6 + sem}"${n === sem ? ' selected' : ''}>${sem}</option>`)
    .join('');
  const placeholder = `<option value="0"${n ? '' : ' selected'}>Select</option>`;
  const table = n
    ? `<table>
      <tr><td>Exam Name</td><td>Academic Period</td><td>Exam Type</td><td>23CSE101</td><td>23CSE102</td></tr>
      <tr><td>IA1</td><td>2025-2026</td><td>Regular</td><td>${10 + n}.0</td><td>NP</td></tr>
      <tr><td>SEE</td><td>2025-2026</td><td>University</td><td>${40 + n}.5</td><td></td></tr>
    </table>`
    : '<table><tr><td>Exam Name</td><td>Academic Period</td><td>Exam Type</td></tr></table>';
  return `<!DOCTYPE html><html><head><title>View Published Mark</title></head><body>
<div id="htmlPageTopContainer">
  <select id="htmlPageTopContainer_selectStep" name="htmlPageTopContainer_selectStep">
    ${placeholder}${options}
  </select>
  <div id="marks">${table}</div>
</div></body></html>`;
}

function send(res, status, body, headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
  res.writeHead(status, Object.assign({ 'Content-Length': buf.length }, headers));
  res.end(buf);
}

function createStubServer(state) {
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      state.requests.push({ method: req.method, path: url.pathname, search: url.search, body: rawBody, cookie: req.headers.cookie || '' });

      // ---- CAS ----------------------------------------------------------
      if (url.pathname === '/cas/login') {
        if (req.method === 'GET') return send(res, 200, CAS_LOGIN_HTML, { 'Content-Type': 'text/html' });
        const form = new URLSearchParams(rawBody);
        if (form.get('username') !== 'student' || form.get('password') !== 'secret') {
          return send(res, 200, CAS_ERROR_HTML, { 'Content-Type': 'text/html' });
        }
        res.writeHead(302, {
          Location: '/aums/Jsp/Common/index.jsp?task=off',
          'Set-Cookie': ['JSESSIONID=CAS-SHELL; Path=/cas', 'CASTGC=TGC-VALUE; Path=/']
        });
        return res.end();
      }

      // ---- AUMS landing (login verification probe) -----------------------
      if (url.pathname === '/aums/Jsp/Common/index.jsp') {
        return send(res, 200, AUMS_LANDING_HTML, {
          'Content-Type': 'text/html',
          'Set-Cookie': 'JSESSIONID=AUMS-SHELL; Path=/'
        });
      }

      // ---- Transport probes ---------------------------------------------
      if (url.pathname === '/echo') {
        return send(res, 200, JSON.stringify({ method: req.method, body: rawBody, cookie: req.headers.cookie || '' }), { 'Content-Type': 'application/json' });
      }
      if (url.pathname === '/redirect1') {
        res.writeHead(302, { Location: '/redirect2', 'Set-Cookie': 'hop=1; Path=/' });
        return res.end();
      }
      if (url.pathname === '/redirect2') {
        if (req.method !== 'GET') return send(res, 405, 'POST must not follow a 302');
        if (!(req.headers.cookie || '').includes('hop=1')) return send(res, 403, 'cookie lost across redirect');
        return send(res, 200, 'redirect-ok');
      }
      if (url.pathname === '/flaky') {
        state.flakyHits += 1;
        if (state.flakyHits <= 2) return send(res, 503, 'upstream sad');
        return send(res, 200, 'recovered');
      }
      if (url.pathname === '/pdf') return send(res, 200, COURSE_PDF, { 'Content-Type': 'application/pdf' });
      if (url.pathname === '/set') {
        return send(res, 200, 'cookie-set', { 'Set-Cookie': 'uid=CLIENT-A; Path=/' });
      }
      if (url.pathname === '/whoami') {
        return send(res, 200, (req.headers.cookie || '').includes('uid=CLIENT-A') ? 'has-a' : 'no-cookie');
      }

      // ---- AUMS attendance ----------------------------------------------
      if (url.pathname === '/aums/Jsp/Attendance/AttendanceReportStudent.jsp') {
        if (state.expired) return send(res, 200, CAS_LOGIN_PAGE_HTML, { 'Content-Type': 'text/html' });
        const action = url.searchParams.get('action') || '';
        if (action.includes('INIT_ATDREPORTSTUD')) {
          return send(res, 200, withCourseOptions(ATTENDANCE_HTML, DEFAULT_SEM_COURSE_OPTIONS), { 'Content-Type': 'text/html' });
        }
        if (action.includes('SHOW_ATDSUMMARY')) {
          // Live portal behaviour: the summary page carries the DEFAULT
          // semester's course dropdown (present but unmatched for other
          // semesters); the requested semester's ids only appear on CHANGESEM.
          return send(res, 200, withCourseOptions(ATTENDANCE_HTML, DEFAULT_SEM_COURSE_OPTIONS), { 'Content-Type': 'text/html' });
        }
        if (action.includes('CHANGESEM_ATDREPORTSTUD')) {
          return send(res, 200, withCourseOptions(ATTENDANCE_HTML), { 'Content-Type': 'text/html' });
        }
        if (action.includes('SHOW_ATDREPORTSTUD')) {
          return send(res, 200, COURSE_PDF, { 'Content-Type': 'application/pdf' });
        }
        return send(res, 404, 'unknown attendance action');
      }

      // ---- AUMS GPA ------------------------------------------------------
      if (url.pathname === '/aums/Jsp/StudentGrade/StudentPerformanceWithSurvey.jsp') {
        if (state.expired) return send(res, 200, CAS_LOGIN_PAGE_HTML, { 'Content-Type': 'text/html' });
        const action = url.searchParams.get('action') || '';
        if (action.includes('CHANGESEM')) {
          const step = new URLSearchParams(rawBody).get('htmlPageTopContainer_selectStep') || '';
          const semester = step === '102' ? 2 : 1;
          return send(res, 200, gpaHtml(semester), { 'Content-Type': 'text/html' });
        }
        return send(res, 200, gpaHtml(1), { 'Content-Type': 'text/html' });
      }

      // ---- AUMS marks ----------------------------------------------------
      if (url.pathname === '/aums/Jsp/Marks/ViewPublishedMark.jsp') {
        if (state.expired) return send(res, 200, CAS_LOGIN_PAGE_HTML, { 'Content-Type': 'text/html' });
        const action = url.searchParams.get('action') || '';
        if (action.includes('STUDMARKVIEW_SELSEM')) {
          const step = new URLSearchParams(rawBody).get('htmlPageTopContainer_selectStep') || '';
          const byId = { 717: 1, 718: 2, 719: 3 };
          return send(res, 200, marksHtml(byId[step] || 1), { 'Content-Type': 'text/html' });
        }
        // INIT: "Select" placeholder + empty table (live portal behaviour).
        return send(res, 200, marksHtml(null), { 'Content-Type': 'text/html' });
      }

      // ---- AUMS profile --------------------------------------------------
      if (url.pathname === '/aums/Jsp/Student/Student.jsp') {
        if (state.expired) return send(res, 200, CAS_LOGIN_PAGE_HTML, { 'Content-Type': 'text/html' });
        return send(res, 200, PROFILE_HTML, { 'Content-Type': 'text/html' });
      }
      if (url.pathname === '/aums/FileUploadServlet') {
        return send(res, 200, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]), { 'Content-Type': 'image/jpeg' });
      }

      return send(res, 404, 'not found');
    });
  });
}

// ---------------------------------------------------------------------------
// Transport-level contract (AuthenticatedHttpClient)
// ---------------------------------------------------------------------------
describe('AuthenticatedHttpClient transport', () => {
  let server;
  let origin;
  const state = { requests: [], flakyHits: 0, expired: false };

  before(async () => {
    server = createStubServer(state);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => { await new Promise((resolve) => server.close(resolve)); });

  test('captures cookies on every redirect hop and upgrades POST to GET', async () => {
    const client = new AuthenticatedHttpClient();
    const res = await client.post(`${origin}/redirect1`, { a: '1' });
    assert.equal(res.status, 200);
    assert.equal(res.body, 'redirect-ok');
    const second = state.requests.find((r) => r.path === '/redirect2');
    assert.equal(second.method, 'GET', '302 must switch the follow-up request to GET');
    assert.match(second.cookie, /hop=1/, 'Set-Cookie from hop 1 must be sent on hop 2');
  });

  test('encodes form bodies as application/x-www-form-urlencoded', async () => {
    const client = new AuthenticatedHttpClient();
    const res = await client.post(`${origin}/echo`, { htmlPageTopContainer_selectSem: '717', note: 'a b&c' });
    const echoed = JSON.parse(res.body);
    assert.equal(echoed.method, 'POST');
    assert.equal(new URLSearchParams(echoed.body).get('htmlPageTopContainer_selectSem'), '717');
    assert.equal(new URLSearchParams(echoed.body).get('note'), 'a b&c');
  });

  test('returns binary responses untouched (course attendance PDF)', async () => {
    const client = new AuthenticatedHttpClient();
    const res = await client.get(`${origin}/pdf`);
    assert.equal(res.status, 200);
    assert.equal(res.buffer.subarray(0, 5).toString('ascii'), '%PDF-');
    assert.ok(res.buffer.equals(COURSE_PDF), 'PDF bytes must survive the transport unchanged');
  });

  test('retries transient 503s with backoff and succeeds', async () => {
    state.flakyHits = 0;
    const client = new AuthenticatedHttpClient();
    const res = await client.get(`${origin}/flaky`);
    assert.equal(res.status, 200);
    assert.equal(res.body, 'recovered');
    assert.equal(state.flakyHits, 3, 'two retries after the initial attempt');
  });

  test('retries can be disabled per request', async () => {
    state.flakyHits = 0;
    const client = new AuthenticatedHttpClient();
    const first = await client.get(`${origin}/flaky`, { retries: 0 });
    assert.equal(first.status, 503);
    assert.equal(state.flakyHits, 1);
  });

  test('cookie jars are isolated between clients (one jar per session)', async () => {
    const clientA = new AuthenticatedHttpClient();
    const clientB = new AuthenticatedHttpClient();
    await clientA.get(`${origin}/set`);
    assert.equal(clientA.cookies.size, 1);

    const a = await clientA.get(`${origin}/whoami`);
    const b = await clientB.get(`${origin}/whoami`);
    assert.equal(a.body, 'has-a');
    assert.equal(b.body, 'no-cookie', 'client B must never see client A cookies');
    assert.equal(clientB.cookies.size, 0);
  });
});

// ---------------------------------------------------------------------------
// Full CAS + AUMS flow over HTTP (the Playwright-free path)
// ---------------------------------------------------------------------------
describe('CAS login + AUMS data over plain HTTP', () => {
  let server;
  let origin;
  let state;
  let client;
  const requestsFor = (needle) => state.requests.filter((r) => r.path.includes(needle));

  before(async () => {
    state = { requests: [], flakyHits: 0, expired: false };
    server = createStubServer(state);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.address().port}`;

    // Must be set BEFORE the modules under test are imported: they read the
    // portal origin once, at module load.
    process.env.AUMS_ORIGIN = origin;
    const { httpLoginOnly } = await import('../browser/login.js');
    const loginResult = await httpLoginOnly('student', 'secret');
    client = loginResult.httpClient;
    assert.ok(client.cookies.size >= 1, 'login must leave auth cookies in the jar');
  });

  after(async () => {
    delete process.env.AUMS_ORIGIN;
    await new Promise((resolve) => server.close(resolve));
  });

  test('CAS credential POST is sent over plain HTTP with the hidden execution token', () => {
    const posts = state.requests.filter((r) => r.path === '/cas/login' && r.method === 'POST');
    assert.equal(posts.length, 1);
    const form = new URLSearchParams(posts[0].body);
    assert.equal(form.get('execution'), 'e1s1');
    assert.equal(form.get('_eventId'), 'submit');
    assert.equal(form.get('username'), 'student');
    assert.equal(form.get('password'), 'secret');
  });

  test('rejected credentials surface as an auth failure (no browser fallback)', async () => {
    const { httpLoginOnly } = await import('../browser/login.js');
    await assert.rejects(
      () => httpLoginOnly('student', 'wrong-password'),
      (error) => {
        assert.match(error.message, /Invalid username or password/);
        assert.equal(error.authFailure, true);
        return true;
      }
    );
  });

  test('attendance semesters come from the INIT page dropdown', async () => {
    const { getAttendanceSemestersHttp } = await import('../services/aumsHttp.js');
    const result = await getAttendanceSemestersHttp(client);
    assert.equal(result.success, true);
    assert.ok(result.semesters.length >= 2);
    assert.deepEqual(result.semesters[0], { id: '717', name: '1' });
    assert.ok(!result.semesters.some((s) => s.id === '0'), 'the "Select" placeholder must be excluded');
  });

  test('attendance summary POSTs the semester + action and parses subjects with course ids', async () => {
    const { getAttendanceReportHttp } = await import('../services/aumsHttp.js');
    const result = await getAttendanceReportHttp(client, '717');
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(result.semester, 'Semester 1');
    assert.equal(result.subjects.length, 1);

    const subject = result.subjects[0];
    assert.equal(subject.courseCode, '23CSE102');
    assert.equal(subject.courseId, '107613', 'course id must be resolved from the dropdown lookup');
    assert.equal(subject.name, 'Computer Hardware Essentials');
    assert.equal(subject.totalClasses, 18);
    assert.equal(subject.attendedClasses, 16);
    assert.equal(subject.attendance, 88.89);

    const summaryPost = state.requests.filter((r) => r.method === 'POST' && r.path.includes('AttendanceReportStudent') && r.body.includes('htmlPageTopContainer_submitSummary'));
    assert.equal(summaryPost.length, 1, 'exactly one summary POST');
    const form = new URLSearchParams(summaryPost[0].body);
    assert.equal(form.get('htmlPageTopContainer_selectSem'), '717');
    assert.equal(form.get('htmlPageTopContainer_action'), 'UMS-ATD_SHOW_ATDSUMMARY_SCREEN');
    assert.ok(form.get('Page_refIndex_hidden') !== null, 'hidden page state must round-trip with the form');

    // The summary page carries no course dropdown on the live portal, so the
    // client must fetch the ids from the CHANGESEM response.
    const changeSem = state.requests.filter((r) => r.method === 'POST' && r.body.includes('htmlPageTopContainer_action=UMS-ATD_CHANGESEM_ATDREPORTSTUD_SCREEN'));
    assert.equal(changeSem.length, 1, 'one CHANGESEM round-trip to recover the course dropdown');
    assert.equal(new URLSearchParams(changeSem[0].body).get('htmlPageTopContainer_selectSem'), '717');
  });

  test('course attendance returns parsed calendar events + the raw PDF', async () => {
    const { getCourseAttendanceHttp } = await import('../services/aumsHttp.js');
    const result = await getCourseAttendanceHttp(client, '717', '107613');
    assert.equal(result.success, true, JSON.stringify(result));
    assert.ok(result.events.length >= 1, 'events parsed from the real PDF fixture');
    assert.equal(result.events[0].date, '2026-07-13');
    assert.equal(result.events[0].status, 'Present');
    assert.ok(result.stats.percentage >= 0);
    assert.equal(Buffer.from(result.rawPdfBase64, 'base64').subarray(0, 5).toString('ascii'), '%PDF-');

    const reportPost = state.requests.filter((r) => r.method === 'POST' && r.body.includes('htmlPageTopContainer_selectCourse=107613'));
    assert.equal(reportPost.length, 1, 'course report POST must carry the course id');
    const form = new URLSearchParams(reportPost[0].body);
    assert.equal(form.get('htmlPageTopContainer_selectType'), '1');
  });

  test('a course CODE resolves to its numeric id (stale-cache fallback)', async () => {
    const { getCourseAttendanceHttp } = await import('../services/aumsHttp.js');
    const before = state.requests.filter((r) => r.method === 'POST' && r.body.includes('htmlPageTopContainer_selectCourse=')).length;

    // The frontend falls back to subject.courseCode when a cached report has no
    // courseId. The backend must accept the code and still submit the id.
    const result = await getCourseAttendanceHttp(client, '717', '23CSE102');
    assert.equal(result.success, true, JSON.stringify(result));

    const reportPosts = state.requests.filter((r) => r.method === 'POST' && r.body.includes('htmlPageTopContainer_selectCourse='));
    // NOTE: the exact POST count varies with how many dropdown-bearing form
    // round-trips the flow needs (the portal renders a course dropdown on the
    // init/summary pages too). The contract: the request that produced the
    // report carries the RESOLVED numeric id, never the raw code.
    assert.ok(reportPosts.length > before, 'the code-resolved course report must be POSTed');
    const form = new URLSearchParams(reportPosts[reportPosts.length - 1].body);
    assert.equal(form.get('htmlPageTopContainer_selectCourse'), '107613', 'code must be resolved to the numeric id');
    assert.notEqual(form.get('htmlPageTopContainer_selectCourse'), '23CSE102');

    // The response is fully populated (parsed from the PDF), proving the
    // resolved id produced a real report rather than an error.
    assert.ok(result.events.length >= 1, 'events parsed for the code-resolved course');
    assert.ok(result.subject.name.length > 0, 'subject name parsed');
  });

  test('course code matching is case-insensitive and ignores the ": Name" suffix', async () => {
    const { getCourseAttendanceHttp } = await import('../services/aumsHttp.js');
    const result = await getCourseAttendanceHttp(client, '717', '23cse102');
    assert.equal(result.success, true, JSON.stringify(result));
  });

  test('unknown course id fails cleanly with the available options', async () => {
    const { getCourseAttendanceHttp } = await import('../services/aumsHttp.js');
    const result = await getCourseAttendanceHttp(client, '717', '999999');
    assert.equal(result.success, false);
    assert.match(result.error, /not available for semester/);
    assert.deepEqual(result.availableCourseIds, ['107613']);
  });

  test('GPA for the pre-selected semester needs a single request', async () => {
    const { getGpaHttp } = await import('../services/aumsHttp.js');
    const before = requestsFor('StudentPerformanceWithSurvey').length;
    const result = await getGpaHttp(client, 1);
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(result.currentCgpa, '8.42');
    assert.equal(result.semesterSgpa, '8.10');
    assert.equal(result.semester, '1');
    assert.equal(result.grades.length, 1);
    assert.equal(result.grades[0].courseCode, '23CSE102', 'SGPA row is a summary, only real grade rows are listed');
    assert.equal(result.grades[0].grade, 'A');
    assert.equal(requestsFor('StudentPerformanceWithSurvey').length - before, 1, 'no CHANGESEM round-trip');
  });

  test('GPA for another semester posts CHANGESEM and parses the new page', async () => {
    const { getGpaHttp } = await import('../services/aumsHttp.js');
    const result = await getGpaHttp(client, 2);
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(result.semester, '2');
    const change = state.requests.filter((r) => r.method === 'POST' && r.body.includes('htmlPageTopContainer_selectStep=102'));
    assert.equal(change.length, 1);
  });

  test('marks need a SELSEM POST because INIT ships the empty "Select" table', async () => {
    const { getMarksHttp } = await import('../services/aumsHttp.js');
    const before = requestsFor('ViewPublishedMark').length;
    const result = await getMarksHttp(client, 1);
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(result.semester, '1');
    assert.deepEqual(result.courses, ['23CSE101', '23CSE102']);
    assert.equal(result.exams.length, 2);
    assert.equal(result.exams[0].name, 'IA1');
    assert.equal(result.exams[0].marks['23CSE101'], 11);
    assert.equal(result.exams[0].marks['23CSE102'], 'NP', 'NP is not a number');
    assert.equal(result.exams[1].marks['23CSE102'], null, 'blank cell → null');

    const selsem = state.requests.filter((r) => r.method === 'POST' && r.path.includes('ViewPublishedMark') && r.body.includes('htmlPageTopContainer_selectStep=717'));
    assert.equal(selsem.length, 1, 'exactly one SELSEM POST with the real semester id');
    assert.ok(requestsFor('ViewPublishedMark').length - before >= 2, 'INIT GET + SELSEM POST');
  });

  test('marks for another semester POSTs that semester and parses its table', async () => {
    const { getMarksHttp } = await import('../services/aumsHttp.js');
    const result = await getMarksHttp(client, 3);
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(result.semester, '3');
    assert.equal(result.exams[0].marks['23CSE101'], 13, 'semester-specific table');
    const selsem = state.requests.filter((r) => r.method === 'POST' && r.body.includes('htmlPageTopContainer_selectStep=719'));
    assert.equal(selsem.length, 1, 'SELSEM must carry the requested semester id');
  });

  test('marks for a semester the student does not have fall back to the first available', async () => {
    const { getMarksHttp } = await import('../services/aumsHttp.js');
    // The portal dropdown only offers semesters 1-3 for this student.
    const result = await getMarksHttp(client, 7);
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(result.semester, '1', 'the payload labels what it actually shows');
    assert.equal(result.exams.length, 2);
  });

  test('profile comes back over HTTP, including the photo as a data URL', async () => {
    const { getProfileHttp } = await import('../services/aumsHttp.js');
    const result = await getProfileHttp(client);
    assert.equal(result.success, true);
    assert.ok(result.name && result.name.length > 3, `name missing: ${result.name}`);
    assert.equal(result.rollNumber, 'AV.EN.U4AID00000');
    assert.ok(result.photo.startsWith('data:image/jpeg;base64,'), 'photo must be inlined');
    const photoRequests = requestsFor('FileUploadServlet');
    assert.equal(photoRequests.length, 1);
    assert.match(photoRequests[0].cookie || '', /JSESSIONID=AUMS-SHELL/, 'photo fetch must carry the session cookie');
  });

  test('an expired upstream session is reported as SESSION_EXPIRED, not garbage', async () => {
    const { getAttendanceSemestersHttp } = await import('../services/aumsHttp.js');
    state.expired = true;
    try {
      await assert.rejects(
        () => getAttendanceSemestersHttp(client),
        (error) => error.code === 'SESSION_EXPIRED'
      );
    } finally {
      state.expired = false;
    }
  });
});
