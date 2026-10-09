// Lightweight, controlled performance instrumentation for AUMS backend.
// Enabled ONLY when AUMS_TIMING_LOG=1 is set (keep production logs clean).
// Usage inside an operation:
//   return withTiming('gpa', session.id, async () => { ... });

const enabled = process.env.AUMS_TIMING_LOG === '1';

const state = { enabled };

function logTiming(name, sessionId, ms, extra = {}) {
  if (!state.enabled) return;
  const sid = sessionId ? String(sessionId).substring(0, 8) : '--------';
  const parts = Object.entries(extra)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${typeof v === 'number' ? Math.round(v) : v}`)
    .join(' ');
  console.log(`[TIMING] ${name} session=${sid} ms=${Math.round(ms)}${parts ? ' ' + parts : ''}`);
}

// Wraps an async operation; never changes its result or error behavior.
async function withTiming(name, sessionId, fn, extraInfoFn) {
  if (!state.enabled) return fn();
  const start = Date.now();
  try {
    const result = await fn();
    let extra = {};
    if (typeof extraInfoFn === 'function') {
      try { extra = extraInfoFn(result) || {}; } catch { /* diagnostics must not break the op */ }
    }
    logTiming(name, sessionId, Date.now() - start, extra);
    return result;
  } catch (error) {
    logTiming(name, sessionId, Date.now() - start, { error: (error && error.message) || 'error' });
    throw error;
  }
}

export default { enabled, logTiming, withTiming };
export { enabled, logTiming, withTiming };
