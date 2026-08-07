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
# Backend
cd backend
npm install

# Frontend
cd ../frontend
npm install
```

### 2. Configure Environment

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

## Production Deployment

### Frontend Build

```bash
cd frontend
npm run build
# Output: frontend/dist/
```

### Nginx Config (example)

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

The frontend production build automatically uses `/api` as the base URL, which nginx proxies to the backend.

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
