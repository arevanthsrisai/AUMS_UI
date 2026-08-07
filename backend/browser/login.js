import { AuthenticatedHttpClient } from '../services/httpClient.js';
import { createContext } from './browser.js';

const AUMS_HOME_URL = 'https://aumscn.amrita.edu/aums/Jsp/Common/index.jsp';
const CAS_LOGIN_URL = 'https://aumscn.amrita.edu/cas/login?service=https://aumscn.amrita.edu/aums/Jsp/Common/index.jsp';

export async function login(username, password) {
  const context = await createContext();
  const page = await context.newPage();

  try {
    console.log('[LOGIN] Navigating to CAS login page...');

    // Navigate to CAS. Use domcontentloaded (faster than networkidle) and then
    // wait for the actual form elements to exist — this ensures the page has
    // fully rendered before we try to interact with it.
    await page.goto(CAS_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Wait for the actual login form to be ready (content-based, not network-based).
    // This fixes the "cookies disabled" error where CAS serves a page but the form
    // hasn't rendered yet.
    await page.waitForSelector('input[name="username"]', { timeout: 15000 });
    await page.waitForSelector('input[name="password"]', { timeout: 5000 });
    await page.waitForSelector('input[type="submit"]', { timeout: 5000 });

    console.log('[LOGIN] CAS form ready, filling credentials...');

    // Fill credentials
    await page.fill('input[name="username"]', username);
    await page.fill('input[name="password"]', password);

    // Submit form AND wait for navigation atomically.
    // Use domcontentloaded instead of networkidle for faster response.
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
      page.click('input[type="submit"]')
    ]);

    console.log('[LOGIN] After submit - URL:', page.url());

    // Wait briefly for CAS redirect chain to complete (CAS does multiple hops).
    // Use a short networkidle timeout just for the redirect chain, not the entire page.
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

    const finalUrl = page.url();
    console.log('[LOGIN] Final URL after CAS:', finalUrl);

    // === ERROR DETECTION ===

    // Check if we're still on CAS (login failed)
    if (finalUrl.includes('/cas/') || finalUrl.includes('login')) {
      const bodyText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');

      // Detect specific CAS error types
      if (bodyText.includes('cookies disabled') || bodyText.includes('does not accept cookies')) {
        throw new Error('Browser cookies are disabled. Please enable cookies and try again.');
      }
      if (bodyText.includes('Invalid credentials') || bodyText.includes('incorrect username or password') || bodyText.includes('Login failed')) {
        throw new Error('Invalid username or password.');
      }
      if (bodyText.includes('account is locked') || bodyText.includes('Account locked')) {
        throw new Error('Account is locked. Please contact your administrator.');
      }

      // Generic CAS error — try to extract the actual error message
      const casErrorMsg = await page.evaluate(() => {
        const errorEl = document.querySelector('.errors') ||
                        document.querySelector('.error') ||
                        document.querySelector('#msg') ||
                        document.querySelector('span.errors') ||
                        document.querySelector('.login-error');
        return errorEl ? errorEl.textContent.trim() : null;
      });

      throw new Error(casErrorMsg || 'Invalid username or password.');
    }

    // Verify we landed on AUMS
    if (!finalUrl.includes('/aums/')) {
      throw new Error('Login failed. Please try again.');
    }

    // Navigate to the frameset if CAS landed on a leaf frame
    if (!finalUrl.includes('Common/index.jsp')) {
      console.log('[LOGIN] Navigating to AUMS home frameset...');
      await page.goto(AUMS_HOME_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      // Short wait for frames to load
      await page.waitForLoadState('domcontentloaded').catch(() => {});
    }

    // Wait for the frame tree — use a generous but bounded timeout.
    // AUMS framesets load quickly; if they don't load in 15s, something is wrong.
    try {
      await page.waitForFunction(() => window.frames.length >= 3, { timeout: 15000 });
    } catch (e) {
      console.warn('[LOGIN] Frame count check timed out, proceeding with available frames');
    }

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

    return { success: true, context, page, httpClient };
  } catch (error) {
    await page.close().catch(() => {});
    await context.close();

    const msg = error.message || 'Login failed';

    // Classify the error type for the frontend with structured codes
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

export default login;
