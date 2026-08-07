import { URL } from 'url';
import https from 'https';
import http from 'http';
import * as cheerio from 'cheerio';

class AuthenticatedHttpClient {
  constructor() {
    this.cookies = new Map();
    this.defaultHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Connection': 'keep-alive'
    };
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
    const parsedUrl = new URL(url);
    const isHttps = parsedUrl.protocol === 'https:';
    const defaultOptions = { method: 'GET', headers: Object.assign({}, this.defaultHeaders), body: null, followRedirects: true, maxRedirects: 10 };
    const mergedOptions = Object.assign({}, defaultOptions, options);
    const cookieHeader = this.getCookieHeader(url);
    if (cookieHeader) mergedOptions.headers.Cookie = cookieHeader;

    if (mergedOptions.body && typeof mergedOptions.body === 'object') {
      if (!mergedOptions.headers['Content-Type']) mergedOptions.headers['Content-Type'] = 'application/x-www-form-urlencoded';
      if (mergedOptions.method === 'GET') {
        const searchParams = new URLSearchParams(mergedOptions.body);
        parsedUrl.search = searchParams.toString();
        mergedOptions.body = null;
      } else {
        mergedOptions.body = new URLSearchParams(mergedOptions.body).toString();
      }
    }

    return new Promise((resolve, reject) => {
      const requestOptions = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: mergedOptions.method,
        headers: mergedOptions.headers,
        rejectUnauthorized: false
      };

      const httpModule = isHttps ? https : http;
      const req = httpModule.request(requestOptions, (res) => {
        let body = Buffer.alloc(0);

        res.on('data', (chunk) => {
          body = Buffer.concat([body, chunk]);
        });

        res.on('end', () => {
          const setCookieHeaders = res.headers['set-cookie'];
          if (setCookieHeaders) {
            this.parseAndStoreCookies(
              url,
              Array.isArray(setCookieHeaders)
                ? setCookieHeaders
                : [setCookieHeaders]
            );
          }

          const response = {
            status: res.statusCode,
            headers: res.headers,
            body: body.toString('utf8'),
            url: res.headers.location || url
          };

          if (
            res.statusCode >= 300 &&
            res.statusCode < 400 &&
            res.headers.location &&
            mergedOptions.followRedirects &&
            mergedOptions.maxRedirects > 0
          ) {
            const redirectUrl = new URL(res.headers.location, url).toString();

            const redirectOptions = {
              ...mergedOptions,
              method: 'GET',
              body: null,
              maxRedirects: mergedOptions.maxRedirects - 1
            };

            delete redirectOptions.headers['Content-Length'];

            this.request(redirectUrl, redirectOptions)
              .then(resolve)
              .catch(reject);

            return;
          }

          resolve(response);
        });
      });

      req.on('error', reject);
      if (mergedOptions.body) req.write(mergedOptions.body);
      req.end();
    });
  }

  async get(url, options = {}) { 
    return this.request(url, Object.assign({}, options, { method: 'GET' })); 
  }
  async post(url, data = {}, options = {}) { return this.request(url, Object.assign({}, options, { method: 'POST', body: data })); }

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
