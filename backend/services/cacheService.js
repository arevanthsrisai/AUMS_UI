// Per-session TTL cache for AUMS-sourced data.
//
// Design constraints:
// - Isolation: every cache is scoped under the owning sessionId. Data is never
//   shared across sessions, so one user can never see another user's data.
// - Coalescing: concurrent identical requests within the same session share one
//   in-flight operation instead of hammering AUMS with duplicates.
// - Stale-while-revalidate: getCached() can serve the last known good value
//   instantly while revalidation happens in the background (used when AUMS
//   fails, so the UI keeps working on transient errors).
// - Lifecycle: invalidations run in bulk when a session is logged out or
//   expired, so nothing outlives its session.

const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes for most AUMS data
const PROFILE_TTL_MS = 30 * 60 * 1000; // profile changes rarely mid-session

class SessionCache {
  constructor() {
    this.map = new Map(); // sessionId -> Map<key, { value, savedAt, ttlMs }>
    this.inflight = new Map(); // sessionId -> Map<key, Promise>
    this.stats = { hits: 0, misses: 0, coalesced: 0, staleServed: 0 };
  }

  _bucket(sessionId) {
    let b = this.map.get(sessionId);
    if (!b) { b = new Map(); this.map.set(sessionId, b); }
    return b;
  }

  get(sessionId, key) {
    const bucket = this.map.get(sessionId);
    if (!bucket) return undefined;
    const entry = bucket.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.savedAt > entry.ttlMs) return undefined; // expired
    this.stats.hits += 1;
    return entry.value;
  }

  peek(sessionId, key) {
    const bucket = this.map.get(sessionId);
    if (!bucket) return undefined;
    const entry = bucket.get(key);
    return entry ? entry.value : undefined;
  }

  set(sessionId, key, value, ttlMs = DEFAULT_TTL_MS) {
    this._bucket(sessionId).set(key, { value, savedAt: Date.now(), ttlMs });
  }

  // get-or-fetch with coalescing. `fetcher` runs only once even if called
  // concurrently with the same (sessionId, key).
  async getOrFetch(sessionId, key, fetcher, ttlMs = DEFAULT_TTL_MS) {
    const cached = this.get(sessionId, key);
    if (cached !== undefined) return cached;

    let inflightBucket = this.inflight.get(sessionId);
    if (!inflightBucket) { inflightBucket = new Map(); this.inflight.set(sessionId, inflightBucket); }
    const existing = inflightBucket.get(key);
    if (existing) {
      this.stats.coalesced += 1;
      return existing;
    }

    const promise = (async () => {
      try {
        const value = await fetcher();
        this.set(sessionId, key, value, ttlMs);
        return value;
        // Note: on fetcher failure the cache entry is not written, so the next
        // request retries against AUMS (fail-open, no stale swallowing here).
      } finally {
        const b = this.inflight.get(sessionId);
        if (b && b.get(key) === promise) b.delete(key);
        if (b && b.size === 0) this.inflight.delete(sessionId);
      }
    })();

    inflightBucket.set(key, promise);
    this.stats.misses += 1;
    return promise;
  }

  // Serve the last known good value even if expired (stale-while-revalidate).
  // Returns { value, fresh } or null.
  peekFreshness(sessionId, key) {
    const bucket = this.map.get(sessionId);
    if (!bucket) return null;
    const entry = bucket.get(key);
    if (!entry) return null;
    return { value: entry.value, fresh: Date.now() - entry.savedAt <= entry.ttlMs };
  }

  invalidate(sessionId, key) {
    const bucket = this.map.get(sessionId);
    if (bucket) bucket.delete(key);
  }

  // Drop everything belonging to one session (logout / expiry).
  invalidateSession(sessionId) {
    this.map.delete(sessionId);
    this.inflight.delete(sessionId);
  }

  clearAll() {
    this.map.clear();
    this.inflight.clear();
  }
}

const cacheService = new SessionCache();

// Stable, namespaced cache keys. Every key embeds the sessionId at call sites.
const cacheKeys = {
  profile: (sid) => `profile:${sid}`,
  gpa: (sid, semester) => `gpa:${sid}:${semester}`,
  marks: (sid, semester) => `marks:${sid}:${semester}`,
  semesters: (sid) => `semesters:${sid}`,
  attendanceReport: (sid, semesterId) => `attReport:${sid}:${semesterId}`,
  courseAttendance: (sid, semesterId, courseId) => `course:${sid}:${semesterId}:${courseId}`,
};

export { cacheService, cacheKeys, PROFILE_TTL_MS, DEFAULT_TTL_MS };
export default cacheService;
