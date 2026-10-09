// Tests for the Phase-2 performance changes.
// Run:  node --test backend/tests/test_optimizations.mjs
// No AUMS credentials needed: Playwright modules run against mock page
// harnesses; the server smoke test starts the real Express wiring but the
// routes exercised never touch Playwright.

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Mock Playwright harness: minimal surface used by the browser modules.
// ---------------------------------------------------------------------------

function makePage({ initialUrl = 'https://aumscn.amrita.edu/aums/Jsp/Common/index.jsp', frames = [] } = {}) {
  let url = initialUrl;
  let frameList = frames;
  const page = {
    url: () => url, // Playwright signature: page.url() is a method
    isClosed: () => false,
    frames: () => frameList,
    async waitForFunction(fn, arg, opts = {}) {
      const deadline = Date.now() + (opts.timeout || 30000);
      for (;;) {
        let result;
        try { result = fn(arg); } catch { result = false; }
        if (result) return true;
        if (Date.now() > deadline) {
          throw new Error('mock: waitForFunction timeout');
        }
        await new Promise((r) => setTimeout(r, 10));
      }
    },
    async waitForSelector() { return true; },
    async waitForTimeout(ms) { await new Promise((r) => setTimeout(r, ms)); },
    on() {},
    close: async () => {},
  };
  return page;
}

// Run a page callback with the browser globals (document/window) injected,
// the way Playwright executes them inside the real page context.
async function withBrowserGlobals(documentObj, windowObj, fn, arg) {
  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  if (documentObj !== undefined) globalThis.document = documentObj;
  if (windowObj !== undefined) globalThis.window = windowObj;
  try {
    return await fn(arg);
  } finally {
    if (prevDoc === undefined) delete globalThis.document; else globalThis.document = prevDoc;
    if (prevWin === undefined) delete globalThis.window; else globalThis.window = prevWin;
  }
}

// ---------------------------------------------------------------------------
// cacheService unit tests
// ---------------------------------------------------------------------------

const { cacheService, cacheKeys, DEFAULT_TTL_MS, PROFILE_TTL_MS } = await import('../services/cacheService.js');

describe('cacheService', () => {
  test('stores and returns values within TTL', () => {
    cacheService.set('s1', 'k1', { v: 1 });
    assert.deepStrictEqual(cacheService.get('s1', 'k1'), { v: 1 });
  });

  test('miss returns undefined', () => {
    assert.strictEqual(cacheService.get('s-miss', 'nope'), undefined);
  });

  test('short-TTL entry expires', async () => {
    cacheService.set('s-ttl', 'e', { v: 1 }, 5);
    await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(cacheService.get('s-ttl', 'e'), undefined);
  });

  test('cross-session isolation: same key, different sessions', () => {
    cacheService.set('sessA', 'gpa', { name: 'Alice' });
    cacheService.set('sessB', 'gpa', { name: 'Bob' });
    assert.strictEqual(cacheService.get('sessA', 'gpa').name, 'Alice');
    assert.strictEqual(cacheService.get('sessB', 'gpa').name, 'Bob');
    cacheService.invalidateSession('sessA');
    assert.strictEqual(cacheService.get('sessA', 'gpa'), undefined);
    assert.strictEqual(cacheService.get('sessB', 'gpa').name, 'Bob'); // untouched
  });

  test('getOrFetch coalesces concurrent identical calls into one fetch', async () => {
    let calls = 0;
    const fetcher = async () => { calls += 1; await new Promise((r) => setTimeout(r, 20)); return { n: calls }; };
    const [a, b, c] = await Promise.all([
      cacheService.getOrFetch('co', 'key', fetcher),
      cacheService.getOrFetch('co', 'key', fetcher),
      cacheService.getOrFetch('co', 'key', fetcher),
    ]);
    assert.strictEqual(calls, 1);
    assert.strictEqual(a.n, 1);
    assert.strictEqual(b.n, 1);
    assert.ok(cacheService.stats.coalesced >= 2);
  });

  test('getOrFetch does not cache failures (next call retries', async () => {
    let calls = 0;
    const boom = async () => { calls += 1; throw new Error('aums down'); };
    await assert.rejects(() => cacheService.getOrFetch('ff', 'k', boom));
    await assert.rejects(() => cacheService.getOrFetch('ff', 'k', boom));
    assert.strictEqual(calls, 2); // retried, not stuck on a cached failure
  });

  test('invalidateSession removes all entries for that session only', () => {
    cacheService.set('invA', 'x', 1);
    cacheService.set('invA', 'y', 2);
    cacheService.set('invB', 'x', 3);
    cacheService.invalidateSession('invA');
    assert.strictEqual(cacheService.get('invA', 'x'), undefined);
    assert.strictEqual(cacheService.get('invA', 'y'), undefined);
    assert.strictEqual(cacheService.get('invB', 'x'), 3);
  });

  test('keys embed the session id (no cross-user aliasing)', () => {
    assert.notStrictEqual(cacheKeys.gpa('A', 1), cacheKeys.gpa('B', 1));
  });

  test('TTL constants sane', () => {
    assert.ok(DEFAULT_TTL_MS >= 5 * 60 * 1000);
    assert.ok(PROFILE_TTL_MS > DEFAULT_TTL_MS);
  });
});

// ---------------------------------------------------------------------------
// pageState detection
// ---------------------------------------------------------------------------

const { inspectPageState } = await import('../browser/pageState.js');

const CAS_LOGOUT_HTML = `<html id="logout-page"><body><div id="msg" class="success"><h2>Logout successful</h2>
<p>You have successfully logged out of the Central Authentication Service.</p></div></body></html>`;

function fakePage(url, bodyText, frameCount = 1) {
  return {
    url: () => url,
    isClosed: () => false,
    frames: () => Array.from({ length: frameCount }, () => ({ url: () => 'https://aumscn.amrita.edu/aums/' })),
    evaluate: async () => bodyText,
  };
}

describe('pageState.inspectPageState', () => {
  test('detects the CAS logout-success page (the "stuck" state)', async () => {
    const p = fakePage('https://aumscn.amrita.edu/cas/logout', CAS_LOGOUT_HTML);
    assert.strictEqual(await inspectPageState(p), 'cas-logout');
  });

  test('detects AUMS logout.jsp as cas-logout', async () => {
    const p = fakePage('https://aumscn.amrita.edu/aums/logout.jsp', CAS_LOGOUT_HTML);
    assert.strictEqual(await inspectPageState(p), 'cas-logout');
  });

  test('detects CAS login form', async () => {
    const p = fakePage('https://aumscn.amrita.edu/cas/login?service=x', '<html><form><input name="username"></form></html>');
    assert.strictEqual(await inspectPageState(p), 'cas-login');
  });

  test('detects healthy AUMS frameset', async () => {
    const p = fakePage('https://aumscn.amrita.edu/aums/Jsp/Common/index.jsp', '<html></html>', 4);
    assert.strictEqual(await inspectPageState(p), 'aums');
  });

  test('unknown for blank page', async () => {
    const p = fakePage('about:blank', '');
    assert.strictEqual(await inspectPageState(p), 'unknown');
  });
});

// ---------------------------------------------------------------------------
// fetchGPA (rewritten): fast path + serial-delta wait
// ---------------------------------------------------------------------------
const { fetchGPA } = await import('../browser/gpa.js');

function makeGpaHarness({ selected = '1', serial = 100, cgpa = '8.91' } = {}) {
  const doc = { selected, serial, cgpa };

  const gpaDoc = {
    querySelectorAll(sel) {
      if (sel === 'label[data-component="orphan-label"]') {
        return [{ textContent: 'Current CGPA' }, { textContent: doc.cgpa }];
      }
      return [];
    },
    querySelector(sel) {
      if (sel === '#htmlPageTopContainer_selectStep') {
        return {
          // locator.evaluate(fn) passes this element to fn — the module reads
          // select.querySelectorAll('option') from it.
          querySelectorAll: (optSel) => (optSel === 'option'
            ? ['1', '2', '3'].map((n) => ({
                value: n,
                textContent: n,
                get selected() { return doc.selected === n; },
              }))
            : []),
          selectedOptions: [{ text: doc.selected }],
          querySelector: (o) => (o === 'option:checked' ? { textContent: doc.selected } : null),
        };
      }
      if (sel === '#fieldset-Grades') {
        const rows = [
          // header row (skipped by the extraction loop)
          [{ textContent: 'Sem' }, { textContent: 'Course Code' }, { textContent: 'Course Name' }, { textContent: 'Term' }, { textContent: 'Type' }, { textContent: 'Grade' }],
          [{ textContent: 'Sem 1' }, { textContent: 'MAT101' }, { textContent: 'Maths' }, { textContent: '2025' }, { textContent: 'Regular' }, { textContent: 'O' }],
          [{ textContent: 'Sem 1' }, { textContent: 'SGPA' }, { textContent: 'x' }, { textContent: '2025' }, { textContent: 'SGPA' }, { textContent: '9.30' }],
        ];
        return {
          querySelector: () => ({
            querySelectorAll: (trSel) => (trSel === 'tr'
              ? rows.map((cells) => ({ querySelectorAll: (tdSel) => (tdSel === 'td' ? cells : []) }))
              : []),
          }),
        };
      }
      return null;
    },
  };

  const menuDoc = {
    querySelectorAll(sel) {
      if (sel === 'li[data-url]') return [{ getAttribute: () => 'StudentPerformanceWithSurvey.jsp?task=off' }];
      return [];
    },
    getElementById: (id) => (id === 'maincontentframe' ? { set src(v) { /* nav recorded */ } } : null),
  };
  const menuFrame = {
    url: () => 'https://aumscn.amrita.edu/aums/Jsp/Core_Common/index.jsp?task=off',
    evaluate: async (fn, arg) => withBrowserGlobals(menuDoc, undefined, fn, arg),
  };

  let posts = 0;
  const gpaFrame = {
    url: () => `https://aumscn.amrita.edu/aums/Jsp/Student/StudentPerformanceWithSurvey.jsp?task=X&pagePostSerialID=${doc.serial}`,
    evaluate: async (fn, arg) => withBrowserGlobals(gpaDoc, undefined, fn, arg),
    locator: (sel) => ({
      // Playwright contract: locator.evaluate(fn) invokes fn(matchedElement)
      evaluate: async (fn) => withBrowserGlobals(gpaDoc, undefined, () => fn(gpaDoc.querySelector(sel))),
      selectOption: async () => { posts += 1; },
    }),
    waitForSelector: async () => true,
  };

  // window.frames view used by page-level predicates (frame URL checks).
  const winFrames = [
    { location: { get href() { return menuFrame.url(); } } },
    {
      location: { get href() { return gpaFrame.url(); } },
      get document() { return gpaDoc; },
    },
  ];

  const page = makePage({ frames: [menuFrame, gpaFrame] });
  page.postCount = () => posts;

  // Emulate the AUMS re-render once the serial-wait predicate starts polling:
  // bump serial + set the selected semester after a short delay.
  const origWait = page.waitForFunction.bind(page);
  page.waitForFunction = async (fn, arg, opts) => {
    if (arg && typeof arg === 'object' && arg.target) {
      setTimeout(() => { doc.serial += 1; doc.selected = arg.target; }, 30);
    }
    return withBrowserGlobals(undefined, { frames: winFrames }, async () => origWait(fn, arg, opts));
  };

  return { page, doc };
}

describe('fetchGPA (rewritten)', () => {
  test('fast path: semester already selected -> no POST', async () => {
    const h = makeGpaHarness({ selected: '1' });
    const res = await fetchGPA(h.page, 1);
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.currentCgpa, '8.91');
    assert.strictEqual(res.semesterSgpa, '9.30');
    assert.strictEqual(res.grades.length, 1); // SGPA row excluded
    assert.strictEqual(h.page.postCount(), 0, 'fast path must not POST');
  });

  test('semester change waits for the serial event (no 3s fixed sleep)', async () => {
    const h = makeGpaHarness({ selected: '1' });
    const t0 = Date.now();
    const res = await fetchGPA(h.page, 2);
    const dt = Date.now() - t0;
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.semester, '2');
    assert.ok(dt < 3000, `serial-delta wait should resolve fast (took ${dt}ms)`);
  });
});

// ---------------------------------------------------------------------------
// fetchAttendanceReport (rewritten): serial wait after summary POST
// ---------------------------------------------------------------------------
const { fetchAttendanceReport } = await import('../browser/attendance_report.js');

function makeReportHarness({ selectedSemester = '1', serial = 50, selectedCourse = '0' } = {}) {
  const doc = { selectedSemester, serial, selectedCourse, summaryClicks: 0 };
  const attendanceDoc = {
    getElementById: (id) => {
      if (id === 'maincontentframe') return { set src(v) { /* nav */ } };
      if (id === 'htmlPageTopContainer_selectSem') return { value: doc.selectedSemester, options: [{ value: '1' }, { value: '2' }] };
      if (id === 'htmlPageTopContainer_selectCourse') return { value: doc.selectedCourse, options: [{ value: '1234', text: '23CSE201: Compiler Design' }] };
      return null;
    },
    querySelector(sel) {
      if (sel === '#htmlPageTopContainer_selectSem') {
        return { value: doc.selectedSemester, options: [{ value: '1' }, { value: '2' }] };
      }
      if (sel === '#htmlPageTopContainer_selectCourse') {
        return { value: doc.selectedCourse, options: [{ value: '1234', text: '23CSE201: Compiler Design' }] };
      }
      return null;
    },
  };
  const attendanceFrame = {
    url: () => `https://aumscn.amrita.edu/aums/Jsp/Student/AttendanceReportStudent.jsp?pagePostSerialID=${doc.serial}`,
    evaluate: async (fn, arg) => withBrowserGlobals(attendanceDoc, undefined, fn, arg),
    locator: () => ({
      waitFor: async () => true,
      evaluateAll: async () => [{ value: '1234', text: '23CSE201: Compiler Design' }],
      selectOption: async () => { doc.selectedSemester = '__pending__'; },
      click: async () => { doc.summaryClicks += 1; },
    }),
    waitForFunction: async () => true,
    content: async () => '<html><table><tr><td>23CSE201</td><td>x</td></tr></table></html>',
  };
  const winFrames = [{
    location: { get href() { return attendanceFrame.url(); } },
    get document() { return attendanceDoc; },
  }];
  const page = makePage({ frames: [attendanceFrame] });
  page.waitForSelector = async () => true;
  // The summary-POST serial wait: emulate AUMS re-render after 30ms.
  const origWait = page.waitForFunction.bind(page);
  page.waitForFunction = async (fn, arg, opts) => {
    if (typeof arg === 'string' || arg === null) {
      setTimeout(() => { doc.serial += 1; doc.summaryClicks += 1; }, 30);
    }
    return withBrowserGlobals(undefined, { frames: winFrames }, async () => origWait(fn, arg, opts));
  };
  return { page, doc };
}

describe('fetchAttendanceReport (rewritten)', () => {
  test('summary path completes quickly (no 60x500ms poll loop)', async () => {
    const h = makeReportHarness({ selectedCourse: '0' });
    const t0 = Date.now();
    const res = await fetchAttendanceReport(h.page, '1');
    const dt = Date.now() - t0;
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.courseLookup['23CSE201'], '1234');
    assert.ok(dt < 5000, `should not run the poll loop (took ${dt}ms)`);
  });

  test('course already selected -> html returned without summary POST', async () => {
    const h = makeReportHarness({ selectedCourse: '1234' });
    const res = await fetchAttendanceReport(h.page, '1');
    assert.strictEqual(res.success, true);
    assert.ok(res.html.includes('23CSE201'));
    assert.strictEqual(h.doc.summaryClicks, 0);
  });
});

// ---------------------------------------------------------------------------
// Express boot smoke test: spawn the real server in a child process (it keeps
// a 5-min sweeper interval alive — in-process import would hang the runner).
// ---------------------------------------------------------------------------

describe('server boot smoke test', () => {
  const { spawn } = require('node:child_process');
  const path = require('node:path');

  function getFreePort() {
    return new Promise((resolve, reject) => {
      const srv = require('node:net').createServer();
      srv.listen(0, '127.0.0.1', () => {
        const port = srv.address().port;
        srv.close(() => resolve(port));
      });
      srv.on('error', reject);
    });
  }

  // ESM import at describe level is avoided; spawn lazily per test file.
  let child = null;
  let port = null;

  const serverReady = (async () => {
    port = await getFreePort();
    child = spawn(process.execPath, [path.resolve(import.meta.dirname, '../server.js')], {
      env: { ...process.env, PORT: String(port) },
      stdio: 'ignore',
    });
    // Poll until the server actually accepts connections instead of a fixed
    // sleep — a cold start on a slow machine used to exceed 1.2s and fail the
    // whole smoke suite spuriously.
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/profile`);
        await res.arrayBuffer(); // drain
        return port; // any HTTP response means the listener is up
      } catch {
        await new Promise((r) => setTimeout(r, 150));
      }
    }
    throw new Error('Test server did not become ready in 15s');
  })();

  test.after(() => { if (child) child.kill(); });

  test('GET /profile without session -> 401 SESSION_EXPIRED', async () => {
    const p = await serverReady;
    const res = await fetch(`http://127.0.0.1:${p}/profile`);
    assert.strictEqual(res.status, 401);
    assert.strictEqual((await res.json()).code, 'SESSION_EXPIRED');
  });

  test('GET /gpa with unknown session -> 401 SESSION_EXPIRED', async () => {
    const p = await serverReady;
    const res = await fetch(`http://127.0.0.1:${p}/gpa?semester=1`, { headers: { 'x-session-id': 'ghost-session' } });
    assert.strictEqual(res.status, 401);
    assert.strictEqual((await res.json()).code, 'SESSION_EXPIRED');
  });

  test('POST /logout for unknown session is idempotent 200', async () => {
    const p = await serverReady;
    const res = await fetch(`http://127.0.0.1:${p}/logout`, { method: 'POST', headers: { 'x-session-id': 'ghost' } });
    assert.strictEqual(res.status, 200);
  });

  test('POST /attendance/report with empty body -> 400 (param validation order preserved)', async () => {
    const p = await serverReady;
    const res = await fetch(`http://127.0.0.1:${p}/attendance/report`, {
      method: 'POST',
      headers: { 'x-session-id': 'ghost', 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.strictEqual(res.status, 400); // semesterId check precedes session lookup (unchanged legacy order)
  });
});
