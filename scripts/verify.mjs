#!/usr/bin/env node
/**
 * AUMS_UI verification harness — one command that runs every check that
 * matters and reports a single pass/fail verdict.
 *
 *   node scripts/verify.mjs           # everything
 *   node scripts/verify.mjs --fast    # skip the frontend production build
 *
 * Checks:
 *   1. backend syntax   — node --check on every backend source file
 *   2. playwright guard — the default (HTTP) path must not statically import
 *                         Playwright; it may only load through the lazy runtime
 *   3. backend tests    — unit + contract suites (node --test)
 *   4. frontend build   — tsc + vite build (skipped with --fast)
 *
 * Exit code 0 = everything green. Any failure prints the failing step's
 * output and exits non-zero, so this can gate CI or a pre-commit hook.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fast = process.argv.includes('--fast');

const results = [];

function run(name, command, args, cwd) {
  const started = Date.now();
  // npm/npx only exist as .cmd shims on Windows, so they need a shell; node
  // itself is launched directly (a shell would break paths with spaces).
  const needsShell = process.platform === 'win32' && /npm(\.cmd)?$/i.test(command);
  const proc = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    shell: needsShell,
    env: { ...process.env, FORCE_COLOR: '0' }
  });
  const ms = Date.now() - started;
  const output = `${proc.stdout || ''}${proc.stderr || ''}`.trim();
  const ok = proc.status === 0;
  results.push({ name, ok, ms, output, command: `${command} ${args.join(' ')}` });
  return ok;
}

function listSourceFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'debug') continue;
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) out.push(full);
    }
  };
  walk(dir);
  return out;
}

// --- 1. backend syntax ------------------------------------------------------
{
  const files = listSourceFiles(path.join(root, 'backend')).filter((f) => !f.includes(`${path.sep}tests${path.sep}`));
  let ok = true;
  for (const file of files) {
    const proc = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (proc.status !== 0) {
      ok = false;
      results.push({ name: `syntax: ${path.relative(root, file)}`, ok: false, ms: 0, output: `${proc.stdout}${proc.stderr}` });
    }
  }
  if (ok) results.push({ name: `backend syntax (${files.length} files)`, ok: true, ms: 0, output: '' });
}

// --- 2. Playwright must stay out of the default path ------------------------
{
  const violations = [];
  const offenders = ['backend/server.js', 'backend/browser/login.js'];
  for (const rel of offenders) {
    const source = fs.readFileSync(path.join(root, rel), 'utf8');
    const staticImports = source.match(/^import[^\n]*$/gm) || [];
    for (const line of staticImports) {
      if (/from\s+'(\.\.\/)*browser\/browser\.js'|from\s+'playwright'/.test(line)) {
        violations.push(`${rel}: ${line.trim()}`);
      }
    }
  }
  if (violations.length) {
    results.push({
      name: 'playwright guard (default path must not import Playwright)',
      ok: false, ms: 0,
      output: `Static Playwright import found:\n${violations.join('\n')}\nLoad it through browser/runtime.js instead.`
    });
  } else {
    results.push({ name: 'playwright guard (default path must not import Playwright)', ok: true, ms: 0, output: '' });
  }
}

// --- 3. backend tests -------------------------------------------------------
run(
  'backend tests (unit + HTTP contract + deployment)',
  process.execPath,
  ['--test', 'tests/test_optimizations.mjs', 'tests/test_http_client.mjs', 'tests/test_deployment.mjs'],
  path.join(root, 'backend')
);

// --- 4. frontend build ------------------------------------------------------
if (fast) {
  results.push({ name: 'frontend build', ok: true, ms: 0, output: 'skipped (--fast)' });
} else {
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
run('frontend build (tsc + vite build)', npmCommand, ['run', 'build'], path.join(root, 'frontend'));
}

// --- report -----------------------------------------------------------------
const pad = (s, n) => String(s).padEnd(n);
console.log('\n================ AUMS_UI verification ================');
for (const r of results) {
  const status = r.ok ? 'PASS' : 'FAIL';
  console.log(`  ${status}  ${pad(r.name, 55)} ${r.ms ? `${(r.ms / 1000).toFixed(1)}s` : ''}`);
}
const failed = results.filter((r) => !r.ok);
console.log('=======================================================');
console.log(failed.length === 0 ? '  ALL CHECKS PASSED' : `  ${failed.length} CHECK(S) FAILED`);
console.log('');

for (const r of failed) {
  console.log(`----- ${r.name} -----`);
  console.log(`$ ${r.command}`);
  console.log(r.output.split('\n').slice(-60).join('\n'));
  console.log('');
}

process.exit(failed.length === 0 ? 0 : 1);
