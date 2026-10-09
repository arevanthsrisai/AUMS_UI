import { AuthenticatedHttpClient } from '../services/httpClient.js';
import { createContext } from './browser.js';

const AUMS_HOME_URL = 'https://aumscn.amrita.edu/aums/Jsp/Common/index.jsp';
const CAS_LOGIN_URL = 'https://aumscn.amrita.edu/cas/login?service=https://aumscn.amrita.edu/aums/Jsp/Common/index.jsp';
const CAS_ORIGIN = 'https://aumscn.amrita.edu';

// Auth errors carry authFailure so the fast path returns INVALID_CREDENTIALS
// immediately instead of retrying through the much slower browser flow.
class CasAuthError extends Error {
  constructor(message) {
    super(message);
    this.authFailure = true;
  }
}

// Recognized CAS error texts (mirrors the browser-path detection).
function classifyCasBody(body) {
  const lower = (body || '').toLowerCase();
  if (lower.includes('cookies disabled') || lower.includes('does not accept cookies')) {
    return 'Browser cookies are disabled. Please enable cookies and try again.';
  }
  if (lower.includes('invalid credentials') || lower.includes('incorrect username or password') || lower.includes('login failed')) {
    return 'Invalid username or password.';
  }
  if (lower.includes('account is locked')) return 'Account is locked. Please contact your administrator.';
  return null;
}

// Best-effort extraction of CAS's inline error element from raw HTML
// (same selectors the browser path queries: .errors/.error/#msg/.login-error).
function extractCasErrorHtml(body) {
  const m = (body || '').match(/class="[^"]*(?:errors?|login-error)[^"]*"[^>]*>([^<]{1,300})</i)
    || (body || '').match(/id="msg"[^>]*>([^<]{1,300})</i);
  return m ? m[1].trim() : null;
}

// === FAST PATH: CAS over plain HTTP (no browser) ============================
// GET the login form, POST credentials + hidden fields (execution, _eventId),
// follow redirects to the AUMS landing. Two requests, ~1.5-2s total — this is
// the same form flow the browser performs, minus rendering. CAS here is a
// plain server-rendered form (verified: no JS challenge).
async function casLoginViaHttp(username, password) {
  const httpClient = new AuthenticatedHttpClient();

  const form = await httpClient.get(CAS_LOGIN_URL);
  if (form.status !== 200) throw new Error(`CAS login form returned HTTP ${form.status}`);
  if (!form.body.includes('name="password"')) throw new Error('CAS login form missing password field');

  const fields = httpClient.extractFormFields(form.body);
  const action = httpClient.extractFormAction(form.body);
  const target = action ? new URL(action, `${CAS_ORIGIN}/cas/login`).href : `${CAS_ORIGIN}/cas/login`;

  const res = await httpClient.post(target, { ...fields, username, password });
  const finalUrl = res.url || '';

  // Bounced back to CAS => credentials rejected (or CAS error page).
  if (finalUrl.includes('/cas/')) {
    throw new CasAuthError(classifyCasBody(res.body) || extractCasErrorHtml(res.body) || 'Invalid username or password.');
  }
  if (!finalUrl.includes('/aums/')) {
    throw new Error(`Unexpected CAS landing: ${finalUrl.slice(0, 120)}`);
  }
  // The post-CAS landing (Core_Common/index.jsp?task=off) is the REAL
  // frameset. Navigate the browser to wherever CAS actually put us.
  return { httpClient, landingUrl: finalUrl };
}

// Open a Playwright context carrying the HTTP-verified session cookies and
// load the AUMS frameset (data modules need a real page/frames to operate on).
async function openAumsSession(httpClient, phase, t0, landingUrl) {
  const context = await createContext();
  try {
    const cookies = [...httpClient.cookies.values()]
      // Skip cookies that are already expired (e.g. CASPRIVACY Max-Age=10) —
      // a real browser would not send them either.
      .filter((ck) => !ck.expires || new Date(ck.expires) > new Date())
      .map((ck) => ({
        name: ck.name,
        value: ck.value,
        domain: ck.domain,
        path: ck.path || '/',
        ...(ck.expires ? { expires: Math.floor(new Date(ck.expires).getTime() / 1000) } : {}),
        secure: !!ck.secure,
        httpOnly: !!ck.httpOnly,
        sameSite: ck.sameSite || 'Lax',
      }));
    await context.addCookies(cookies);

    const page = await context.newPage();
    // Diagnostics: log any request that takes >700ms so slow logins are
    // attributable from the logs. Guarded: an exception inside a Playwright
    // event handler is an uncaught exception and would kill the whole server —
    // diagnostics must never do that.
    const reqStart = new Map();
    page.on('request', (req) => {
      try { reqStart.set(req, Date.now()); } catch { /* diagnostic only */ }
    });
    const logSlow = (req, status) => {
      try {
        const start = reqStart.get(req);
        const ms = start ? Date.now() - start : -1;
        if (ms > 700) console.log(`[LOGIN][+${((Date.now() - t0) / 1000).toFixed(1)}s] SLOW ${status} ${req.resourceType()} ${ms}ms ${req.url().slice(0, 110)}`);
      } catch { /* diagnostic only */ }
    };
    page.on('requestfinished', (req) => logSlow(req, 'done'));
    page.on('requestfailed', (req) => logSlow(req, 'failed'));

    const tNav = Date.now();
    // 'commit' (first byte) instead of 'domcontentloaded': DCL was measured at
    // ~8s while the document response itself arrived in ~0.5s. We only need
    // the final URL and the frames tree below — both waited for directly.
    await page.goto(landingUrl || AUMS_HOME_URL, { waitUntil: 'commit', timeout: 30000 });

    // Ride out the landing's ONE-TIME init bounce. Verified timeline: the
    // frameset loads, its JS (dhtmlx layout manager) rebuilds the frame
    // structure ~3s in, then the top window bounces through the Sakai portal
    // (/index.jsp -> /portal/login -> sakai-login-tool -> CAS TGC SSO ->
    // /portal) and lands back on the frameset — ~6s of churn in which EVERY
    // child frame is detached and re-created. Any data operation racing this
    // window loses its frame mid-action ("Frame was detached" — this is what
    // broke /attendance/report and emptied the calendar). Aborting the bounce
    // navigation is NOT safe (Chromium replaces the frameset with an error
    // page), so we wait for it: detect the URL leaving /aums/, then wait for
    // the return. Capped: on a landing that never bounces (already-initiated
    // page), we proceed after the cap.
    const bounceDeadline = Date.now() + 6500;
    while (Date.now() < bounceDeadline && page.url().includes('/aums/')) {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    if (!page.url().includes('/aums/')) {
      const backDeadline = Date.now() + 10000;
      while (Date.now() < backDeadline && !page.url().includes('/aums/')) {
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      console.log(`[LOGIN][+${((Date.now() - t0) / 1000).toFixed(1)}s] portal bounce completed`);
    }
    console.log(`[LOGIN][+${((Date.now() - t0) / 1000).toFixed(1)}s] goto commit took ${Date.now() - tNav}ms | browser frames: ${page.frames().length}`);
    phase('AUMS landing committed (cookie session)');

    // If the injected session didn't take, we land on the CAS form instead.
    // (If only the TGC survived, CAS SSO already bounced us back to AUMS.)
    if (!page.url().includes('/aums/')) {
      throw new Error(`Landing bounced to ${page.url().slice(0, 100)}`);
    }

    // Bounded frames settle. Poll page.frames() from the DRIVER side instead
    // of evaluating window.frames inside the page: in-page evaluations can be
    // dropped while the landing renderer is busy, whereas the driver-side
    // frame tree stays accurate and the bound honest.
    const settleDeadline = Date.now() + 10000;
    while (Date.now() < settleDeadline && page.frames().length < 2) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    // Wait (bounded) for each child frame's document to actually finish
    // loading. The frameset assigns final-looking URLs immediately, but the
    // maincontentframe runs a server redirect chain (StaffMainPage.jsp) for
    // several seconds after that. If a data request navigates
    // maincontentframe while that chain is still in flight, the pending
    // redirect replaces our navigation and detaches the frame mid-operation
    // (observed as "locator.selectOption: Frame was detached" on
    // /attendance/report — which made the calendar come back empty).
    // Waiting for child 'load' hands the data modules a page whose default
    // navigation has fully completed.
    const loadDeadline = Date.now() + 9000;
    await Promise.all(
      page.frames().slice(1).map((frame) =>
        frame.waitForLoadState('load', { timeout: Math.max(1000, loadDeadline - Date.now()) }).catch(() => {})
      )
    );

    // Final quiet check: frame URLs must hold still briefly (redirect churn
    // settled) before we hand the page over.
    const quietDeadline = Date.now() + 4000;
    let lastSignature = null;
    let stableSince = Date.now();
    while (Date.now() < quietDeadline) {
      const signature = page.frames().map((f) => { try { return f.url(); } catch { return ''; } }).join('|');
      if (signature !== lastSignature) {
        lastSignature = signature;
        stableSince = Date.now();
      } else if (Date.now() - stableSince >= 500) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    console.log(`[LOGIN][+${((Date.now() - t0) / 1000).toFixed(1)}s] after settle: browser frames=${page.frames().length} (loaded+stable)`);
    phase('frames settled');

    // Re-sync any cookies the AUMS landing set/rotated in the browser so the
    // HTTP client and the browser context stay identical.
    await httpClient.importCookiesFromPlaywright(context);
    return { context, page };
  } catch (error) {
    await context.close().catch(() => {});
    throw error;
  }
}

// === FALLBACK: full browser-driven login ====================================
// Used when the HTTP fast path hits something unexpected (not bad credentials):
// network oddities, CAS markup changes, landing verification failure. This is
// the original, proven flow.
async function loginViaBrowser(username, password, t0, phase) {
  const context = await createContext();
  phase('context ready (browser launch/reuse)');
  const page = await context.newPage();

  // Permanent diagnostics: log how long each top-level document request
  // (CAS form, CAS POST, AUMS landing) actually takes, so slow logins are
  // attributable from the logs instead of guessed.
  const docStarts = new Map();
  page.on('request', (req) => {
    if (req.resourceType() === 'document') docStarts.set(req, Date.now());
  });
  const logDoc = (req, status) => {
    if (req.resourceType() !== 'document') return;
    const start = docStarts.get(req);
    const ms = start ? Date.now() - start : -1;
    console.log(`[LOGIN][+${((Date.now() - t0) / 1000).toFixed(1)}s] doc ${status} ${ms}ms ${req.url().slice(0, 110)}`);
  };
  page.on('requestfinished', (req) => logDoc(req, 'done'));
  page.on('requestfailed', (req) => logDoc(req, 'failed'));

  try {
    console.log('[LOGIN] Navigating to CAS login page...');

    // Navigate to CAS. Use domcontentloaded (faster than networkidle) and then
    // wait for the actual form elements to exist — this ensures the page has
    // fully rendered before we try to interact with it.
    await page.goto(CAS_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    phase('CAS login page loaded');

    // Only the username field needs an explicit wait (page render readiness).
    // fill()/click() below auto-wait for their own elements — three serialized
    // waitForSelector calls here just added latency on every login.

    console.log('[LOGIN] Filling credentials...');

    // Fill both fields concurrently — each fill auto-waits for its own input,
    // and the two waits are independent.
    await Promise.all([
      page.fill('input[name="username"]', username),
      page.fill('input[name="password"]', password),
    ]);

    // Submit form AND wait for navigation atomically.
    // Use domcontentloaded instead of networkidle for faster response.
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
      page.click('input[type="submit"]')
    ]);
    phase('CAS submit + redirect done');

    console.log('[LOGIN] After submit - URL:', page.url());

    // NOTE: no networkidle here on purpose. The AUMS shell pulls an asset-heavy
    // chain (ckeditor, dhtmlx, print.css...) so networkidle never settles fast;
    // the landing URL below is already a sufficient success signal and every
    // data module waits for its own frames/content afterwards.
    const finalUrl = page.url();
    console.log('[LOGIN] Final URL after CAS:', finalUrl);

    // === ERROR DETECTION ===

    // Check if we're still on CAS (login failed)
    if (finalUrl.includes('/cas/') || finalUrl.includes('login')) {
      const bodyText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');

      const known = classifyCasBody(bodyText);
      if (known) throw new CasAuthError(known);

      // Generic CAS error — try to extract the actual error message
      const casErrorMsg = await page.evaluate(() => {
        const errorEl = document.querySelector('.errors') ||
                        document.querySelector('.error') ||
                        document.querySelector('#msg') ||
                        document.querySelector('span.errors') ||
                        document.querySelector('.login-error');
        return errorEl ? errorEl.textContent.trim() : null;
      });

      throw new CasAuthError(casErrorMsg || 'Invalid username or password.');
    }

    // Verify we landed on AUMS
    if (!finalUrl.includes('/aums/')) {
      throw new Error('Login failed. Please try again.');
    }

    // Navigate to the frameset if CAS landed on a leaf frame
    if (!finalUrl.includes('Common/index.jsp')) {
      console.log('[LOGIN] Navigating to AUMS home frameset...');
      await page.goto(AUMS_HOME_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    }

    // Short bounded settle: give the frameset a moment to start building, but
    // never wait for it — the first data route re-verifies page state via
    // ensureAumsReady() and its own content-based waits.
    //
    // IMPORTANT (two gotchas, both cost 30s on every login when wrong):
    // 1. waitForFunction's signature is (fn, arg, options) — passing the
    //    options object as the 2nd arg silently treats it as `arg` and uses
    //    the DEFAULTS (30s timeout, rAF polling). Always pass `undefined`
    //    for arg when the predicate takes no arguments.
    // 2. Use timer polling, not the default rAF: the AUMS landing page blocks
    //    its renderer while building the frameset, so rAF callbacks never
    //    fire and the predicate is never even evaluated until it unblocks.
    try {
      await page.waitForFunction(() => window.frames.length >= 2, undefined, { timeout: 800, polling: 100 });
    } catch {
      console.warn('[LOGIN] Frames not settled after 0.8s — proceeding (data modules tolerate partial frames)');
    }
    phase('frames settled');

    console.log('[LOGIN] Login successful - URL:', page.url(), '| Frames:', page.frames().length);

    // Verify cookies exist
    const cookies = await context.cookies();
    const aumsCookies = cookies.filter(c => c.domain.includes('aumscn.amrita.edu'));
    console.log('[LOGIN] Auth cookies:', aumsCookies.length, aumsCookies.map(c => c.name).join(', '));
    if (aumsCookies.length === 0) {
      throw new Error('Login failed. Session not established.');
    }

    // Build HTTP client
    const httpClient = new AuthenticatedHttpClient();
    await httpClient.importCookiesFromPlaywright(context);
    phase('done');

    return { success: true, context, page, httpClient };
  } catch (error) {
    await page.close().catch(() => {});
    await context.close();

    const msg = error.message || 'Login failed';

    // Auth errors (bad credentials, locked, cookies) are definitive — don't
    // degrade into generic codes.
    if (error.authFailure) {
      console.error('[LOGIN] Auth error:', msg);
      return { success: false, code: 'INVALID_CREDENTIALS', error: msg };
    }
    if (msg.includes('Invalid') || msg.includes('password') || msg.includes('credentials') ||
        msg.includes('cookies are disabled') || msg.includes('locked') || msg.includes('rejected')) {
      console.error('[LOGIN] Auth error:', msg);
      return { success: false, code: 'INVALID_CREDENTIALS', error: msg };
    }
    if (msg.includes('Timeout') || msg.includes('timeout') || msg.includes('ETIMEDOUT')) {
      console.error('[LOGIN] Network timeout:', msg);
      return { success: false, code: 'AUMS_TIMEOUT', error: 'AUMS is taking too long to respond. Please try again in a moment.' };
    }

    // Check if this is a Playwright-level error
    if (msg.includes('Target closed') || msg.includes('Session closed') || msg.includes('Browser')) {
      console.error('[LOGIN] Playwright error:', msg);
      return { success: false, code: 'PLAYWRIGHT_ERROR', error: 'A browser error occurred. Please try again.' };
    }

    console.error('[LOGIN] Unexpected error:', msg);
    return { success: false, code: 'INTERNAL_ERROR', error: 'Login failed. Please try again.' };
  }
}

export async function login(username, password) {
  const t0 = Date.now();
  const phase = (label) => console.log(`[LOGIN][+${((Date.now() - t0) / 1000).toFixed(1)}s] ${label}`);

  // FAST PATH: plain-HTTP CAS login, then load AUMS with the verified cookies.
  let httpClient = null;
  let session = null;
  try {
    const httpLogin = await casLoginViaHttp(username, password);
    httpClient = httpLogin.httpClient;
    phase('CAS HTTP login done');
    session = await openAumsSession(httpClient, phase, t0, httpLogin.landingUrl);
  } catch (error) {
    if (error && error.authFailure) {
      console.error('[LOGIN] Auth error:', error.message);
      return { success: false, code: 'INVALID_CREDENTIALS', error: error.message };
    }
    console.warn(`[LOGIN] HTTP fast path failed (${error.message}) — falling back to browser login`);
    httpClient = null;
    session = null;
  }

  if (!session) {
    return loginViaBrowser(username, password, t0, phase);
  }

  const { context, page } = session;
  const cookies = await context.cookies();
  const aumsCookies = cookies.filter((c) => c.domain.includes('aumscn.amrita.edu'));
  console.log('[LOGIN] Login successful via HTTP fast path | Auth cookies:', aumsCookies.length, aumsCookies.map((c) => c.name).join(', '));
  if (aumsCookies.length === 0) {
    await context.close().catch(() => {});
    return loginViaBrowser(username, password, t0, phase);
  }
  phase('done');
  return { success: true, context, page, httpClient };
}

export default login;
