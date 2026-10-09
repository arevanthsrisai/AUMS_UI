import { chromium } from 'playwright';

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
