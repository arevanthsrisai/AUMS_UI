// Playwright is an OPTIONAL, lazily-loaded dependency of this backend. Nothing
// in the default (HTTP) runtime path imports it; it is only needed when the
// explicit browser fallback is enabled (AUMS_BROWSER_FALLBACK=1) AND the HTTP
// login path failed. This keeps the default install and boot footprint light.

async function loadChromium() {
  try {
    const { chromium } = await import('playwright');
    return chromium;
  } catch (error) {
    const err = new Error(
      'Playwright is not installed. The browser fallback (AUMS_BROWSER_FALLBACK=1) requires it — ' +
      'run `npm i playwright` in backend/ to enable it. Original error: ' + error.message
    );
    err.code = 'PLAYWRIGHT_MISSING';
    throw err;
  }
}

let browser = null;
let launchPromise = null;

export async function getBrowser() {
  if (browser && browser.isConnected()) return browser;

  // Singleton with concurrent-launch protection (two logins racing).
  if (launchPromise) return launchPromise;

  launchPromise = (async () => {
    if (browser && browser.isConnected()) return browser;
    if (browser) {
      // Previous browser crashed/exited — clear it so a fresh one is launched.
      try { await browser.close(); } catch { /* already dead */ }
      browser = null;
    }
    const chromium = await loadChromium();
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    return browser;
  })();

  try {
    return await launchPromise;
  } finally {
    launchPromise = null;
  }
}

export async function closeBrowser() {
  if (browser) {
    const b = browser;
    browser = null;
    launchPromise = null;
    try { await b.close(); } catch { /* ignore */ }
  }
}

export async function createContext() {
  const browser = await getBrowser();
  return await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
}

export default { getBrowser, closeBrowser, createContext };
