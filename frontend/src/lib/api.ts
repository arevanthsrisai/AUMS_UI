// Dev: split origins — Vite on :5173, Express on :3001 (overridable via
// VITE_API_BASE for pointing at the mock backend, etc.).
// Prod: ALWAYS same-origin "/api" — the Express server serves both the built
// frontend and the API (combined deployment, e.g. Render). Hard-coding the
// prod branch (instead of honoring a leftover VITE_API_BASE) prevents a dev
// .env.local from being baked into a production bundle.
export const API_BASE = import.meta.env.DEV
  ? (import.meta.env.VITE_API_BASE ?? "http://localhost:3001")
  : "/api";

/**
 * Fetch with a timeout. If the server doesn't respond within `ms` milliseconds,
 * the request is aborted and an error is thrown. This prevents the UI from
 * hanging when AUMS is slow or unreachable.
 */
export async function fetchWithTimeout(
  url: string | URL | Request,
  init?: RequestInit,
  ms = 100_000
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Structured error codes matching the backend.
export const ErrorCode = {
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  AUMS_TIMEOUT: 'AUMS_TIMEOUT',
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  AUMS_UNAVAILABLE: 'AUMS_UNAVAILABLE',
  PLAYWRIGHT_ERROR: 'PLAYWRIGHT_ERROR',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface ApiError {
  success: false;
  code: ErrorCode;
  error: string;
}

export function isSessionExpired(code?: string): boolean {
  return code === ErrorCode.SESSION_EXPIRED;
}

export function isTimeout(code?: string): boolean {
  return code === ErrorCode.AUMS_TIMEOUT;
}

export function isAuthError(code?: string): boolean {
  return code === ErrorCode.INVALID_CREDENTIALS;
}
