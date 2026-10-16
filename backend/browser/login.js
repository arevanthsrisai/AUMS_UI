import { AuthenticatedHttpClient } from '../services/httpClient.js';

// Playwright is loaded ONLY inside the browser fallback (dynamic import) so the
// default HTTP path never pays the module cost and never launches Chromium.
// The browser fallback is opt-in: set AUMS_BROWSER_FALLBACK=1 to allow it.

// Portal origin. Overridable so contract tests can run the whole login flow
// against a local CAS+AUMS stub; production always uses the real portal.
const AUMS_ORIGIN = (process.env.AUMS_ORIGIN || 'https://aumscn.amrita.edu').replace(/\/+$/, '');
const AUMS_HOME_URL = `${AUMS_ORIGIN}/aums/Jsp/Common/index.jsp`;
const CAS_LOGIN_URL = `${AUMS_ORIGIN}/cas/login?service=${AUMS_ORIGIN}/aums/Jsp/Common/index.jsp`;
const CAS_ORIGIN = AUMS_ORIGIN;

// Auth errors carry authFailure so the fast path returns INVALID_CREDENTIALS
// immediately instead of retrying through the much slower browser flow.

class CasAuthError extends Error {
  constructor(message) {
    super(message);
    this.authFailure = true;
  }
}

// Recognized CAS error texts (mirrors the browser-path detection).
//
// IMPORTANT: the CAS page ships a HIDDEN #cookiesDisabled warning div
// (style="display:none") in its markup on EVERY render, so a raw body scan
// for "cookies disabled" would misreport every failed login as a cookie
// problem. Only trust that text when the div is actually visible.
function classifyCasBody(body) {
  const lower = (body || '').toLowerCase();
  const cookiesDiv = lower.match(/<div[^>]*id=["']cookiesdisabled["'][^>]*>/);
  const cookiesVisible = !!cookiesDiv && !/display\s*:\s*none/.test(cookiesDiv[0]);
  if (cookiesVisible && (lower.includes('cookies disabled') || lower.includes('does not accept cookies'))) {
    return 'Browser cookies are disabled. Please enable cookies and try again.';
  }
  if (lower.includes('invalid credentials') || lower.includes('incorrect username or password') || lower.includes('login failed')) {
    return 'Invalid username or password.';
  }
  if (lower.includes('account is locked')) return 'Account is locked. Please contact your administrator.';
  return null;
}

// Best-effort extraction of CAS's inline error element from raw HTML.
// Prefer the live #msg element (the actual rendered error); the generic
// .errors match comes second because the hidden #cookiesDisabled div also
// carries class="errors".
function extractCasErrorHtml(body) {
  const msg = (body || '').match(/id="msg"[^>]*>([^<]{1,300})</i);
  if (msg && msg[1].trim()) return msg[1].trim();
  const m = (body || '').match(/class="[^"]*(?:errors?|login-error)[^"]*"[^>]*>([^<]{1,300})</i);
  return m && m[1].trim() ? m[1].trim() : null;
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

// === FALLBACK: full browser-driven login ====================================
// Used when the HTTP fast path hits something unexpected (not bad credentials):
// network oddities, CAS markup changes, landing verification failure. This is
// the original, proven flow.
async function loginViaBrowser(username, password, t0, phase) {
  const { createContext } = await import('./browser.js');
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

    return { success: true, mode: 'browser', context, page, httpClient };
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

// Transient upstream conditions worth one quick retry before giving up on the
// HTTP path (AUMS/CAS occasionally answers 502/503 under load or drops a socket).
function isTransientLoginError(error) {
  if (!error) return false;
  if (error.authFailure) return false; // bad credentials are definitive
  const code = error.code || '';
  if (['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'EPIPE', 'ENOTFOUND', 'ECONNABORTED', 'ERR_NETWORK'].includes(code)) return true;
  if (/HTTP 50[234]|HTTP 429|timeout|timed out|socket hang up|network/i.test(error.message || '')) return true;
  return false;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * HTTP-only login: CAS form over plain HTTP + AUMS landing verification.
 * Never touches Playwright. Used by the main login flow and by the silent
 * re-login that recovers an expired HTTP session.
 */
export async function httpLoginOnly(username, password) {
  const { httpClient, landingUrl } = await casLoginViaHttp(username, password);

  const probe = await httpClient.get(AUMS_HOME_URL);
  const probeIsLogin = !probe.body ||
    probe.body.includes('name="password"') ||
    /<title[^>]*>\s*CAS\s*Login/i.test(probe.body);
  if (probeIsLogin) throw new Error('AUMS rejected the HTTP session cookies');

  console.log('[LOGIN] HTTP-only session established | auth cookies:', httpClient.cookies.size);
  return { httpClient, landingUrl };
}

export async function login(username, password) {
  const t0 = Date.now();
  const phase = (label) => console.log(`[LOGIN][+${((Date.now() - t0) / 1000).toFixed(1)}s] ${label}`);

  // HTTP-FIRST: CAS over plain HTTP, then verify the cookie session actually
  // opens an AUMS screen. When this succeeds NO Playwright context exists —
  // every data route runs on the per-session cookie jar alone.
  let lastHttpError = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const { httpClient } = await httpLoginOnly(username, password);
      phase('done');
      return { success: true, mode: 'http', httpClient };
    } catch (error) {
      lastHttpError = error;
      if (error && error.authFailure) {
        console.error('[LOGIN] Auth error:', error.message);
        return { success: false, code: 'INVALID_CREDENTIALS', error: error.message };
      }
      if (attempt < 2 && isTransientLoginError(error)) {
        phase(`HTTP attempt ${attempt} transient failure (${error.message}) — retrying`);
        await sleep(400);
        continue;
      }
      break;
    }
  }

  // Playwright fallback is opt-in: it costs a Chromium launch and the package
  // is no longer a default dependency. Everything AUMS offers to this app is
  // reachable over plain HTTP, so the browser path is a last resort only.
  if (process.env.AUMS_BROWSER_FALLBACK !== '1') {
    console.warn(`[LOGIN] HTTP sign-in failed (${lastHttpError.message}) — browser fallback disabled (set AUMS_BROWSER_FALLBACK=1 to allow it)`);
    return {
      success: false,
      code: 'AUMS_UNAVAILABLE',
      error: 'AUMS did not accept the sign-in request. Please try again in a moment.'
    };
  }
  console.warn(`[LOGIN] HTTP fast path failed (${lastHttpError.message}) — falling back to browser login`);
  return loginViaBrowser(username, password, t0, phase);
}

export default login;
