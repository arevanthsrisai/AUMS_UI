import { URL } from 'url';
import https from 'https';
import axios from 'axios';
import * as cheerio from 'cheerio';

const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);
const RETRYABLE_ERROR_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ECONNABORTED', 'EPIPE',
  'EAI_AGAIN', 'ENOTFOUND', 'ERR_NETWORK', 'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET', 'ERR_CANCELED'
]);

// Exponential backoff with jitter: 250ms, 500ms, 1000ms ... (bounded).
function backoff(attempt) {
  const base = Math.min(250 * (2 ** attempt), 4000);
  return new Promise((resolve) => setTimeout(resolve, base + Math.floor(Math.random() * 150)));
}

/**
 * Per-session authenticated HTTP client backed by axios.
 *
 * Cookie handling is intentionally manual (a Map keyed by domain+path+name with
 * RFC6265 matching) — this is the exact logic the previous raw-https client
 * used and it is proven against the real CAS + AUMS cookie chain. What changed
 * in the migration: the transport is axios (timeouts, clean header handling,
 * binary bodies via responseType:'arraybuffer'), redirects are followed hop by
 * hop so every intermediate Set-Cookie is captured, and responses expose both
 * a utf8 `body` (HTML) and the raw `buffer` (PDF/image downloads).
 *
 * One instance per login session → complete session isolation between users.
 */
class AuthenticatedHttpClient {
  constructor() {
    this.cookies = new Map();
    this.defaultHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Connection': 'keep-alive'
    };
    this.client = axios.create({
      timeout: 30_000,
      maxRedirects: 0, // redirects are followed manually below (cookie capture per hop)
      validateStatus: () => true,
      responseType: 'arraybuffer',
      // Matches the previous client's behavior (AUMS/CAS cert chain).
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
      transitional: { clarifyTimeoutError: true }
    });
  }

  async importCookiesFromPlaywright(playwrightContext) {
    const cookies = await playwrightContext.cookies();
    cookies.forEach(cookie => this.cookies.set(cookie.domain + cookie.path + cookie.name, cookie));
  }

  /**
   * Check if a cookie matches the request URL according to RFC6265
   * @param {string} requestDomain - The hostname from the request URL
   * @param {string} requestPath - The pathname from the request URL
   * @param {string} requestProtocol - The protocol from the request URL
   * @param {object} cookie - The cookie object
   * @returns {boolean} - True if the cookie should be sent
   */
  matchesRequest(requestDomain, requestPath, requestProtocol, cookie) {
      const cookieDomain = cookie.domain.startsWith('.')
          ? cookie.domain.substring(1)
          : cookie.domain;

      const domainMatch =
          requestDomain === cookieDomain ||
          requestDomain.endsWith('.' + cookieDomain);

      const pathMatch = requestPath.startsWith(cookie.path);

      const secureMatch =
          !cookie.secure || requestProtocol === 'https:';

      const notExpired =
          cookie.expires === undefined ||
          cookie.expires === null ||
          cookie.expires === -1 ||
          new Date(cookie.expires) >= new Date();

      return domainMatch && pathMatch && secureMatch && notExpired;
  }

  getCookieHeader(url) {
    try {
      const parsedUrl = new URL(url);
      const domain = parsedUrl.hostname;
      const path = parsedUrl.pathname;
      const protocol = parsedUrl.protocol;
      const cookieParts = [];

      this.cookies.forEach((cookie, key) => {
        if (this.matchesRequest(domain, path, protocol, cookie)) {
          cookieParts.push(cookie.name + '=' + cookie.value);
        }
      });

      const cookieHeader = cookieParts.length > 0 ? cookieParts.join('; ') : '';
      return cookieHeader;
    } catch (error) {
      console.log('Error in getCookieHeader: ' + error.message);
      return '';
    }
  }

  async request(url, options = {}) {
    const defaultOptions = { method: 'GET', headers: Object.assign({}, this.defaultHeaders), body: null, followRedirects: true, maxRedirects: 10 };
    const mergedOptions = Object.assign({}, defaultOptions, options);

    let currentUrl = url;
    let method = mergedOptions.method;
    let body = mergedOptions.body;
    let redirectsLeft = mergedOptions.maxRedirects;

    for (;;) {
      const headers = Object.assign({}, this.defaultHeaders, mergedOptions.headers || {});
      const cookieHeader = this.getCookieHeader(currentUrl);
      if (cookieHeader) headers.Cookie = cookieHeader;

      let data = null;
      if (body && typeof body === 'object') {
        if (!headers['Content-Type']) headers['Content-Type'] = 'application/x-www-form-urlencoded';
        data = new URLSearchParams(body).toString();
      } else if (typeof body === 'string' && body) {
        data = body;
        if (!headers['Content-Type']) headers['Content-Type'] = 'application/x-www-form-urlencoded';
      }

      const res = await this.requestWithRetry({
        url: currentUrl,
        method,
        headers,
        data,
        responseType: 'arraybuffer'
      }, mergedOptions);

      const buffer = Buffer.isBuffer(res.data) ? res.data : Buffer.from(res.data || []);

      const setCookieHeaders = res.headers['set-cookie'];
      if (setCookieHeaders) {
        this.parseAndStoreCookies(
          currentUrl,
          Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders]
        );
      }

      const location = res.headers.location;
      if (mergedOptions.followRedirects && res.status >= 300 && res.status < 400 && location && redirectsLeft > 0) {
        // Browser-style 302 semantics: switch to GET and drop the body.
        currentUrl = new URL(location, currentUrl).toString();
        method = 'GET';
        body = null;
        redirectsLeft -= 1;
        continue;
      }

      return {
        status: res.status,
        headers: res.headers,
        body: buffer.toString('utf8'),
        url: currentUrl,
        buffer
      };
    }
  }

  async get(url, options = {}) {
    return this.request(url, Object.assign({}, options, { method: 'GET' }));
  }
  async post(url, data = {}, options = {}) { return this.request(url, Object.assign({}, options, { method: 'POST', body: data })); }

  // --- Resilient transport -------------------------------------------------
  // AUMS/CAS intermittently answers 502/503 under load or drops a socket
  // mid-flight. Every hop (including each redirect hop) is retried with
  // exponential backoff + jitter so callers see a single clean response
  // instead of a transient failure. Opt out per request with { retries: 0 }.
  isRetryable(error, status) {
    if (error) {
      const code = error.code || '';
      if (RETRYABLE_ERROR_CODES.has(code)) return true;
      return /timeout|timed out|socket hang up|network error|ECONNRESET/i.test(error.message || '');
    }
    return RETRYABLE_STATUSES.has(status);
  }

  async requestWithRetry(config, options = {}) {
    const maxRetries = Number.isInteger(options.retries) ? options.retries : 2;
    let attempt = 0;
    for (;;) {
      try {
        const res = await this.client.request(config);
        if (attempt < maxRetries && this.isRetryable(null, res.status)) {
          await backoff(attempt++);
          continue;
        }
        return res;
      } catch (error) {
        if (attempt < maxRetries && this.isRetryable(error)) {
          await backoff(attempt++);
          continue;
        }
        throw error;
      }
    }
  }

  parseAndStoreCookies(url, setCookieHeaders) {
    if (!setCookieHeaders || !Array.isArray(setCookieHeaders)) return;
    try {
      const parsedUrl = new URL(url);
      setCookieHeaders.forEach(setCookieHeader => {
        const cookie = this.parseCookie(setCookieHeader, parsedUrl.hostname, parsedUrl.pathname);
        if (cookie) this.cookies.set(cookie.domain + cookie.path + cookie.name, cookie);
      });
    } catch (error) { console.error('Error parsing cookies:', error.message); }
  }

  parseCookie(setCookieHeader, domain, path) {
    try {
      const parts = setCookieHeader.split(';').map(p => p.trim());
      if (parts.length === 0) return null;
      const nameValue = parts[0].split('=');
      if (nameValue.length < 2) return null;
      const cookie = { name: nameValue[0], value: nameValue.slice(1).join('='), domain: domain, path: path, httpOnly: false, secure: false, sameSite: 'Lax' };
      for (let i = 1; i < parts.length; i++) {
        const part = parts[i].toLowerCase();
        if (part === 'httponly') cookie.httpOnly = true;
        else if (part === 'secure') cookie.secure = true;
        else if (part.startsWith('expires=')) cookie.expires = new Date(part.substring(8));
        else if (part.startsWith('max-age=')) { const maxAge = parseInt(part.substring(8)); if (!isNaN(maxAge)) cookie.expires = new Date(Date.now() + maxAge * 1000); }
        else if (part.startsWith('domain=')) cookie.domain = part.substring(7);
        else if (part.startsWith('path=')) cookie.path = part.substring(5);
        else if (part.startsWith('samesite=')) cookie.sameSite = part.substring(9);
      }
      return cookie;
    } catch (error) { return null; }
  }

  extractHiddenInputs(html) {
    const hiddenInputs = {};
    const $ = cheerio.load(html);
    $('input[type="hidden"]').each((i, el) => { const name = $(el).attr('name'); const value = $(el).attr('value') || ''; if (name) hiddenInputs[name] = value; });
    return hiddenInputs;
  }

  extractFormAction(html) {
    const $ = cheerio.load(html);
    return $('form').first().attr('action') || null;
  }

  extractFormFields(html) {
    const fields = {};
    const $ = cheerio.load(html);
    $('input, select, textarea').each((i, el) => {
      const name = $(el).attr('name');
      if (!name) return;
      let value = '';
      if ($(el).is('input')) { const type = $(el).attr('type') || 'text'; if (type === 'checkbox' || type === 'radio') { if ($(el).attr('checked')) value = $(el).attr('value') || 'on'; } else { value = $(el).attr('value') || ''; } }
      else if ($(el).is('select')) value = $(el).find('option[selected]').attr('value') || $(el).find('option').first().attr('value') || '';
      else if ($(el).is('textarea')) value = $(el).text();
      fields[name] = value;
    });
    return fields;
  }
}

const httpClient = new AuthenticatedHttpClient();
export default httpClient;
export { AuthenticatedHttpClient };
