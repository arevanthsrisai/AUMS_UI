// Combined single-origin deployment tests (Render-style: one Express process
// serves both the API and the production-built frontend).
//
// Verifies the contract the production frontend relies on:
//   - /health            -> platform liveness probe
//   - /api/<route>       -> every API route (API_BASE="/api" in prod builds)
//   - /<route>           -> legacy root paths still work (dev + old tests)
//   - /                  -> index.html (SPA shell)
//   - /any/client/route  -> index.html fallback (client-side routing)
//   - /api/unknown       -> JSON 404, never the SPA shell
//
// A fixture "dist" directory is generated so the suite runs without a real
// Vite build; the server honors FRONTEND_DIST for exactly this purpose.

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

describe('combined deployment (static frontend + /api on one origin)', () => {
  let child = null;
  let port = null;
  let distDir = null;

  const serverReady = (async () => {
    // Fixture frontend build: one HTML shell + one hashed asset.
    distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aums-dist-'));
    fs.mkdirSync(path.join(distDir, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(distDir, 'index.html'), '<!doctype html><html><body><div id="root"></div></body></html>');
    fs.writeFileSync(path.join(distDir, 'assets', 'main-abc123.js'), 'console.log("app");');

    port = await getFreePort();
    child = spawn(process.execPath, [path.resolve(import.meta.dirname, '../server.js')], {
      env: { ...process.env, PORT: String(port), FRONTEND_DIST: distDir },
      stdio: 'ignore',
    });
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`);
        await res.arrayBuffer();
        return port;
      } catch {
        await new Promise((r) => setTimeout(r, 150));
      }
    }
    throw new Error('Combined-deployment test server did not become ready in 15s');
  })();

  test.after(() => {
    if (child) child.kill();
    if (distDir) fs.rmSync(distDir, { recursive: true, force: true });
  });

  test('GET /health -> 200 ok (platform liveness probe)', async () => {
    const p = await serverReady;
    const res = await fetch(`http://127.0.0.1:${p}/health`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(await res.text(), 'ok');
  });

  test('GET / serves the SPA shell (index.html)', async () => {
    const p = await serverReady;
    const res = await fetch(`http://127.0.0.1:${p}/`);
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/html/);
    assert.match(await res.text(), /<div id="root">/);
    // Shell must never be cached hard — users need fresh deploys immediately.
    assert.match(res.headers.get('cache-control') || '', /no-cache/);
  });

  test('GET /some/client/route falls back to index.html (SPA routing)', async () => {
    const p = await serverReady;
    const res = await fetch(`http://127.0.0.1:${p}/attendance/detail/123`);
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/html/);
    assert.match(await res.text(), /<div id="root">/);
  });

  test('hashed asset is served with immutable caching', async () => {
    const p = await serverReady;
    const res = await fetch(`http://127.0.0.1:${p}/assets/main-abc123.js`);
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('cache-control') || '', /immutable/);
  });

  test('API under /api: GET /api/profile without session -> 401 JSON', async () => {
    const p = await serverReady;
    const res = await fetch(`http://127.0.0.1:${p}/api/profile`);
    assert.strictEqual(res.status, 401);
    const body = await res.json();
    assert.strictEqual(body.code, 'SESSION_EXPIRED');
  });

  test('API under /api: POST /api/login validates input -> 400', async () => {
    const p = await serverReady;
    const res = await fetch(`http://127.0.0.1:${p}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.strictEqual(res.status, 400);
    assert.strictEqual((await res.json()).code, 'INVALID_CREDENTIALS');
  });

  test('API under /api: POST /api/logout is idempotent 200', async () => {
    const p = await serverReady;
    const res = await fetch(`http://127.0.0.1:${p}/api/logout`, { method: 'POST', headers: { 'x-session-id': 'ghost' } });
    assert.strictEqual(res.status, 200);
  });

  test('legacy root API paths still work (split-origin dev + old tests)', async () => {
    const p = await serverReady;
    const res = await fetch(`http://127.0.0.1:${p}/profile`);
    assert.strictEqual(res.status, 401);
    assert.strictEqual((await res.json()).code, 'SESSION_EXPIRED');
  });

  test('GET /api/unknown -> JSON 404, not the SPA shell', async () => {
    const p = await serverReady;
    const res = await fetch(`http://127.0.0.1:${p}/api/does-not-exist`);
    assert.strictEqual(res.status, 404);
    assert.match(res.headers.get('content-type') || '', /json/);
    const body = await res.json();
    assert.strictEqual(body.success, false);
  });
});
