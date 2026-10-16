# AUMS UI

A modern, production-ready React + TypeScript application that fetches and displays student data from the Amrita AUMS portal. Features a premium SaaS-grade UI with full session persistence, offline-first caching, and responsive design.

## Features

- **Authentication** — Secure login with session management
- **Dashboard** — Profile overview, GPA summary, quick actions, semester selector
- **Attendance Summary** — Semester-wise attendance with subject cards, progress rings
- **Course-wise Attendance** — Day-level attendance calendar with drill-down modal
- **Calendar** — Month/week/agenda views with colored status indicators
- **GPA Analytics** — Animated grade distribution, performance insights, trend charts
- **Spotlight Search** — ⌘K fuzzy search across subjects, GPA, calendar, settings
- **Settings** — Theme toggle (light/dark/system), profile management

## Architecture

```
AUMS_UI/
├── backend/                    # Node.js + Express + Playwright
│   ├── server.js              # Express entry point
│   ├── browser/               # Playwright automation (login, profile, gpa, attendance, course)
│   ├── parsers/               # HTML/PDF parsers (attendance, GPA, course PDF)
│   ├── services/              # Business logic (attendance, course, http client)
│   ├── package.json
│   └── .env.example
├── frontend/                   # React 18 + Vite + TypeScript
│   ├── src/
│   │   ├── App.tsx            # Root component, auth, routing, persistence
│   │   ├── Login.tsx
│   │   ├── main.tsx
│   │   ├── index.css
│   │   ├── components/
│   │   │   ├── ui/            # Reusable primitives (Card, Badge, Toast, etc.)
│   │   │   ├── layout/        # AppShell, Sidebar, Topbar
│   │   │   ├── CourseDetailsModal.tsx
│   │   │   └── SpotlightSearch.tsx
│   │   ├── hooks/
│   │   │   ├── useAttendanceData.ts
│   │   │   ├── useCurrentSemester.ts
│   │   │   └── useTheme.ts
│   │   ├── pages/
│   │   │   ├── DashboardPage.tsx
│   │   │   ├── AttendancePage.tsx
│   │   │   ├── CalendarPage.tsx
│   │   │   ├── GpaPage.tsx
│   │   │   └── SettingsPage.tsx
│   │   ├── lib/
│   │   │   ├── api.ts         # Centralized API base URL config
│   │   │   ├── storage.ts     # localStorage persistence layer
│   │   │   ├── utils.ts
│   │   │   └── rollNumber.ts
│   │   ├── hooks/
│   │   └── vite-env.d.ts
│   ├── index.html
│   ├── vite.config.ts
│   ├── tailwind.config.js
│   ├── tsconfig.json
│   └── package.json
├── debug/                      # Debug artifacts (gitignored)
│   ├── credentials/
│   ├── dumps/
│   ├── logs/
│   ├── pdfs/
│   ├── html/
│   └── har/
├── .env.example                # Environment variables template
├── .gitignore
└── README.md
```

## Prerequisites

- **Node.js 18+**
- **npm 9+**

## Quick Start

### 1. Clone & Install

```bash
npm run setup   # from the repo root: npm ci in both backend/ and frontend/
```

(Equivalently: `cd backend && npm install`, then `cd ../frontend && npm install`.)

### 2. Configure (optional)

```bash
# Backend (optional)
cd backend
cp .env.example .env
# Edit .env if needed (PORT=3001)

# Frontend (optional)
cd ../frontend
cp ../.env.example .env
# Edit .env if needed (VITE_API_BASE for custom backend URL)
```

### 3. Run Development

```bash
# Terminal 1 - Backend
cd backend
npm run dev

# Terminal 2 - Frontend
cd frontend
npm run dev
```

- Backend: `http://localhost:3001`
- Frontend: `http://localhost:5173`

## Environment Variables

| Variable | Location | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | backend/.env | `3001` | Backend server port |
| `AUMS_USERNAME` | frontend/.env | — | Test credentials for `test_client.js` |
| `AUMS_PASSWORD` | frontend/.env | — | Test credentials for `test_client.js` |
| `VITE_API_BASE` | frontend/.env | auto | Override API base URL (dev: `http://localhost:3001`, prod: `/api`) |

**Note:** The frontend automatically detects environment:
- `npm run dev` → `http://localhost:3001`
- Production build → `/api` (proxied by nginx)
- `VITE_API_BASE` overrides both

Credentials are submitted through the login request body at runtime — the server never reads them from its own environment.

## API Endpoints

All endpoints except `POST /login` require the `x-session-id` header returned by login.

| Method | Endpoint | Body / Query | Description |
|--------|----------|--------------|-------------|
| POST | `/login` | `{ username, password }` | Authenticate; returns `{ sessionId }` |
| POST | `/logout` | — | Destroy session and invalidate the AUMS/CAS session |
| GET | `/profile` | — | Student profile (name, roll, branch, photo, …) |
| GET | `/attendance` | — | Available semesters |
| POST | `/attendance/report` | `{ semesterId }` | Attendance summary with per-subject totals |
| POST | `/attendance/course` | `{ semesterId, courseId }` | Daily course attendance (events + stats + raw PDF). Accepts a numeric course id or a course code like `23CSE102` |
| GET | `/course-attendance/pdf` | `?semesterId=&courseId=` | The raw course attendance PDF |
| GET | `/gpa` | `?semester=` | CGPA, semester SGPA, and course grades |
| GET | `/marks` | `?semester=` | Published exam marks matrix (courses, exams, per-cell marks / NP / blank) |

Error responses are JSON with `code` values the frontend handles: `INVALID_CREDENTIALS`, `SESSION_EXPIRED`, `AUMS_TIMEOUT`, `AUMS_UNAVAILABLE`, `INTERNAL_ERROR`.

## Verification and Tests

The project ships a single verification harness that runs every check that matters:

```bash
node scripts/verify.mjs          # everything
node scripts/verify.mjs --fast   # skip the frontend production build
```

It runs, in order: backend syntax checks (`node --check` on every source file), a **Playwright guard** (asserts the default path never statically imports `playwright`), the backend test suites, and the frontend production build (`tsc && vite build`). Exit code `0` means everything passed; any failure prints the failing step's output and exits non-zero, so it can gate CI or a pre-commit hook.

Run just the backend tests:

```bash
cd backend && npm test
# or directly:
node --test tests/test_optimizations.mjs tests/test_http_client.mjs
```

The suites are credential-free. `tests/test_http_client.mjs` spins up a local stub AUMS server and drives the real HTTP clients against it (using the real fixtures in `tests/fixtures/`) to verify CAS login, cookie handling, form POSTs, PDF parsing, the published-marks matrix, and session-expiry detection. `tests/test_optimizations.mjs` covers caching, page-state detection, and a server smoke test.

### Live end-to-end (needs real credentials)

```bash
cd backend
AUMS_USERNAME=... AUMS_PASSWORD=... node test_e2e.js
```

This exercises login, profile, GPA, marks, attendance, course attendance, logout, and concurrent-session isolation against the real portal.

## Frontend Notes

- **Session persistence** — the session id and fetched data live in `localStorage` under a versioned namespace (`aums:session:1`, `aums:ui:1`, `aums:cache:1:<key>`), with a 15-minute freshness TTL. Reload restores cached data instantly, then revalidates.
- **Offline-first** — attendance, GPA, profile, and course data hydrate from cache and refresh in the background (stale-while-revalidate).
- **Attendance intelligence** — risk levels, bunkable/reachable class counts, and projections are computed client-side in [`frontend/src/lib/attendanceMath.ts`](frontend/src/lib/attendanceMath.ts); they never cost an AUMS request. The attendance target slider recomputes instantly for the same reason.
- **Responsive** — full sidebar on desktop, collapsible on tablet, drawer navigation on mobile.
- **TypeScript** — strict mode, no unused locals/parameters.

### Frontend scripts

```bash
npm run dev      # Vite dev server
npm run build    # type-check + production build → frontend/dist/
npm run preview  # preview the production build
```

### Backend scripts

```bash
npm run dev      # node --watch server.js
npm start        # node server.js
npm test         # node --test on both suites
npm run verify   # full harness (delegates to scripts/verify.mjs)
```

## Production Deployment — one folder, one process

The repo root is a single deployable unit. A root [`package.json`](package.json)
drives both sub-projects, and the Express server serves the built frontend
(`frontend/dist`) **and** the JSON API under `/api` from the same origin — no
nginx, no second service.

| Root script | What it does |
|-------------|--------------|
| `npm run setup` | `npm ci` in both `backend/` and `frontend/` |
| `npm run build` | type-check + production build → `frontend/dist/` |
| `npm start` | combined server: `/api` + static frontend + `/health` |
| `npm test` | full verification harness |

### Deploy on Render

1. Push this repo to GitHub.
2. Render → **New → Blueprint** → select the repo. [`render.yaml`](render.yaml)
   defines a single web service: `buildCommand: npm run setup && npm run build`,
   `startCommand: npm start`, `healthCheckPath: /health`.
3. Render assigns `PORT` automatically; `backend/server.js` binds it
   (dual-stack, `0.0.0.0`/`::`) and serves everything on one public URL.

No environment variables are required to boot — the HTTP path to AUMS needs no
browser install (see `AUMS_BROWSER_FALLBACK` above).

### Alternative: split static + API behind nginx

Serve `frontend/dist/` statically and proxy `/api/` to a separately running
backend. Example nginx config:

```nginx
server {
    listen 80;
    server_name your-domain.com;

    # Frontend static files
    location / {
        root /path/to/frontend/dist;
        try_files $uri $uri/ /index.html;
    }

    # Backend API proxy
    location /api/ {
        proxy_pass http://localhost:3001/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

The production build uses `/api` as its base URL, so the `location /api/` block above is what connects it to the backend. (With the root `npm start` deployment the Express server already answers `/api` itself — the nginx split is only needed if you host the static files separately.)

## Debug Directory

All development artifacts are organized under `debug/` (gitignored):

```
debug/
├── credentials/     # test_client.js (uses env vars)
├── dumps/           # Backup scripts, diagnostic files
├── logs/            # Server logs, client output
├── pdfs/            # Course attendance PDFs
├── html/            # Page HTML dumps, click screenshots
└── har/             # Network HAR files
```

## Key Implementation Details

### Session Persistence
- `localStorage` with versioned keys (`aums:v1:session`, `aums:v1:ui`, `aums:v1:cache:*`)
- 15-minute TTL for data cache
- Auto-restores on reload: cached data → validate session → refresh if needed
- Full logout clears all persisted data

### Centralized API Config
Single source of truth at `frontend/src/lib/api.ts`:
```ts
export const API_BASE =
  import.meta.env.VITE_API_BASE ??
  (import.meta.env.DEV ? "http://localhost:3001" : "/api");
```

### Responsive Design
- Desktop: Full sidebar, multi-column grids
- Tablet: Collapsible sidebar, 2-column layouts
- Mobile: Drawer navigation, single-column cards, touch-friendly targets (`touch-manipulation`)

### TypeScript
Strict mode enabled. Zero `any`, zero unused locals/parameters.

## Available Scripts

### Backend
```bash
npm run dev    # Development with --watch
npm start      # Production
```

### Frontend
```bash
npm run dev     # Vite dev server
npm run build   # Type-check + production build
npm run preview # Preview production build
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/login` | Authenticate with AUMS, returns `sessionId` |
| POST | `/logout` | Invalidate session |
| GET | `/profile` | Student profile (name, roll, branch, etc.) |
| GET | `/attendance` | Available semesters |
| GET | `/attendance/report?semesterId=` | Attendance summary |
| GET | `/attendance/course?semesterId=&courseId=` | Course-wise daily attendance |
| GET | `/gpa?semester=` | GPA data (CGPA, SGPA, grades) |

All GET endpoints require `x-session-id` header.

## Tech Stack

- **Frontend:** React 18, TypeScript, Vite, Tailwind CSS, Framer Motion, Recharts, Lucide React
- **Backend:** Node.js, Express, Playwright, Cheerio, pdf-parse
- **Storage:** localStorage (persistence), sessionStorage (ephemeral)
- **Build:** Vite, esbuild, TypeScript (strict)

## License

MIT
