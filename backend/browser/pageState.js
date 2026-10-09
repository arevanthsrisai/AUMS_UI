// Page-state guard + session recovery for the shared Playwright page.
//
// Failure mode this fixes: AUMS's server-side session dies (timeout, server
// restart, upstream logout) while our BrowserContext still holds cookies. The
// next operation's frame-finding fails and the UI "gives up" with a generic
// error. The HAR shows the concrete stuck-state page: AUMS's own logout chain
// (/aums/logout.jsp -> /portal/logout -> /cas/logout) renders the
// "Logout successful" CAS page (body id="logout-page", div#msg.success).
//
// Recovery: the same context usually still holds a valid CAS SSO cookie (TGC),
// so navigating the page back to AUMS home re-establishes the AUMS session via
// CAS redirects (no credentials involved, no user impact). If the TGC is also
// gone, CAS shows the login form — in that case we report a clean
// SESSION_EXPIRED so the frontend can prompt for re-login instead of glitching.

const AUMS_HOME_URL = 'https://aumscn.amrita.edu/aums/Jsp/Common/index.jsp';

const CAS_LOGOUT_MARKERS = [
  'id="logout-page"',
  'Logout successful',
  'You have successfully logged out of the Central Authentication Service',
];

const CAS_LOGIN_MARKER = 'input[name="username"]';

// CAS error texts seen in login.js — reused for classification.
const CAS_COOKIE_ERROR_MARKERS = ['cookies disabled', 'does not accept cookies'];
const CAS_INVALID_MARKERS = ['Invalid credentials', 'incorrect username or password', 'Login failed'];
const CAS_LOCKED_MARKERS = ['account is locked', 'Account locked'];

function extractInnerTextSync() {
  // Evaluated inside the page.
  return document.body ? document.body.innerText : '';
}

async function readBodyText(page) {
  try {
    return await page.evaluate(extractInnerTextSync);
  } catch {
    return '';
  }
}

// Lightweight synchronous check via page URL + frame URLs (no network).
function looksLoggedOutByUrl(page) {
  try {
    const url = page.url() || '';
    if (url.includes('/cas/logout') || url.includes('/aums/logout.jsp') || url.includes('/portal/logout')) return true;
  } catch { /* closed page */ }
  return false;
}

export function isCasLoggedOutPage(page) {
  const byUrl = looksLoggedOutByUrl(page);
  if (!byUrl) return Promise.resolve(false);
  return readBodyText(page).then((text) => {
    const t = (text || '').toLowerCase();
    if (CAS_LOGOUT_MARKERS.some((m) => t.includes(m.toLowerCase()))) return true;
    // On the CAS logout URL but body text unknown (e.g. detached) — still treat
    // as logged out; recovery will verify properly.
    return true;
  });
}

// Inspect the current page state. Returns one of:
//   'aums'        — AUMS frameset present, good to go
//   'cas-login'   — CAS login form visible (no SSO; needs full re-login)
//   'cas-logout'  — CAS "Logout successful" page (recoverable via SSO usually)
//   'unknown'     — anything else (blank tab, error page, about:blank)
export async function inspectPageState(page) {
  if (!page || page.isClosed ? page.isClosed() : false) return 'unknown';
  const url = page.url() || '';

  if (url.includes('/cas/login') || url === 'about:blank') {
    // Distinguish login form vs other CAS pages by body content.
    const text = await readBodyText(page);
    const lower = (text || '').toLowerCase();
    if (CAS_COOKIE_ERROR_MARKERS.some((m) => lower.includes(m))) return 'cas-login';
    if (CAS_INVALID_MARKERS.some((m) => lower.includes(m))) return 'cas-login';
    if (CAS_LOCKED_MARKERS.some((m) => lower.includes(m))) return 'cas-login';
    if (lower.includes('logout successful') || CAS_LOGOUT_MARKERS.some((m) => lower.includes(m.toLowerCase()))) return 'cas-logout';
    if (url.includes('/cas/login')) return 'cas-login';
    return 'unknown';
  }

  if (url.includes('/cas/logout') || url.includes('/aums/logout.jsp') || url.includes('/portal/logout')) {
    return 'cas-logout';
  }

  if (url.includes('/aums/')) {
    const frames = page.frames().length;
    const hasAumsFrame = page.frames().some((f) => (f.url() || '').includes('/aums/'));
    if (frames >= 2 || hasAumsFrame) return 'aums';
    // /aums/ URL but no frames yet — could be mid-load; treat as unknown so
    // callers can decide to wait or recover.
    return 'unknown';
  }

  return 'unknown';
}

export { CAS_LOGIN_MARKER };

// Attempt transparent recovery of the AUMS session using existing cookies.
// Returns 'recovered' | 'needs-login' | 'failed'.
export async function recoverAumsSession(page, log = () => {}) {
  try {
    await page.goto(AUMS_HOME_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (error) {
    log(`recovery goto failed: ${error.message}`);
    return 'failed';
  }

  // Let the CAS redirect chain finish if one is happening.
  try {
    await page.waitForLoadState('networkidle', { timeout: 8000 });
  } catch { /* best-effort */ }

  const state = await inspectPageState(page);
  if (state === 'aums') {
    try {
      // Signature is (fn, arg, options): `undefined` arg is required or the
      // options object is taken as arg and defaults (30s/rAF) apply.
      // Timer polling: rAF never fires while the renderer builds the frameset
      // (see login.js).
      await page.waitForFunction(() => window.frames.length >= 2, undefined, { timeout: 10000, polling: 200 });
    } catch { /* frames may be slow; data modules tolerate partial frames */ }
    return 'recovered';
  }
  if (state === 'cas-login') return 'needs-login';
  if (state === 'cas-logout') {
    // Even the SSO is gone (or CAS logged us out explicitly) — retry once via
    // the "Click Here to login" link target (same as AUMS_HOME_URL) which will
    // bounce us to the CAS login form if no TGC exists.
    try {
      await page.goto(AUMS_HOME_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForLoadState('networkidle', { timeout: 8000 });
    } catch { /* ignore */ }
    const second = await inspectPageState(page);
    if (second === 'aums') return 'recovered';
    if (second === 'cas-login') return 'needs-login';
    return 'failed';
  }
  return 'failed';
}

// Full CAS re-login using the SAME context (fresh page), preserving cookies.
// The caller must supply credentials only when it actually has them (the
// /login route does); data routes must NOT hold credentials.
// Returns { success: true } or { success: false, code, error }.
export async function reloginInContext(context, username, password, log = () => {}) {
  const page = await context.newPage();
  try {
    await page.goto(AUMS_HOME_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('input[name="username"]', { timeout: 15000 });
    await page.fill('input[name="username"]', username);
    await page.fill('input[name="password"]', password);
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
      page.click('input[type="submit"]'),
    ]);
    try { await page.waitForLoadState('networkidle', { timeout: 8000 }); } catch { /* best effort */ }

    const state = await inspectPageState(page);
    if (state === 'cas-login') {
      // Still on the login form: wrong credentials or CAS error page.
      const text = await readBodyText(page);
      const lower = (text || '').toLowerCase();
      if (CAS_INVALID_MARKERS.some((m) => lower.includes(m.toLowerCase()))) {
        return { success: false, code: 'INVALID_CREDENTIALS', error: 'Invalid username or password.' };
      }
      if (CAS_COOKIE_ERROR_MARKERS.some((m) => lower.includes(m.toLowerCase()))) {
        return { success: false, code: 'INVALID_CREDENTIALS', error: 'Browser cookies are disabled. Please enable cookies and try again.' };
      }
      if (CAS_LOCKED_MARKERS.some((m) => lower.includes(m.toLowerCase()))) {
        return { success: false, code: 'INVALID_CREDENTIALS', error: 'Account is locked. Please contact your administrator.' };
      }
      return { success: false, code: 'INVALID_CREDENTIALS', error: 'AUMS did not accept the login.' };
    }

    // Success: AUMS home frameset.
    try {
      // Timer polling + explicit undefined arg — see note in recoverAumsSession.
      await page.waitForFunction(() => window.frames.length >= 2, undefined, { timeout: 10000, polling: 200 });
    } catch { /* tolerate */ }
    return { success: true, page };
  } catch (error) {
    log(`relogin error: ${error.message}`);
    const msg = error.message || '';
    if (/timeout|Timeout|ETIMEDOUT/.test(msg)) {
      return { success: false, code: 'AUMS_TIMEOUT', error: 'AUMS is taking too long to respond. Please try again in a moment.' };
    }
    return { success: false, code: 'PLAYWRIGHT_ERROR', error: 'A browser error occurred during re-login.' };
  }
}

// Best-effort AUMS/CAS logout used by the /logout route: drive the page through
// AUMS's own logout chain so server-side state is really destroyed, then close
// the context locally. Never throws; bounded in time.
export async function performAumsLogout(page) {
  if (!page || (page.isClosed && page.isClosed())) return;
  try {
    await page.goto('https://aumscn.amrita.edu/aums/logout.jsp', { waitUntil: 'domcontentloaded', timeout: 10000 });
  } catch { /* page may be mid-navigation; still try CAS logout */ }
  try {
    await page.goto('https://aumscn.amrita.edu/cas/logout', { waitUntil: 'domcontentloaded', timeout: 10000 });
  } catch { /* ignore */ }
  // No waits after this: the caller closes the context immediately after.
}
