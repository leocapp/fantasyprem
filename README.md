# FantasyPrem

Fantasy soccer for real-world leagues — draft and manage a roster of real players, score points from real match performance.

This repo is currently a **skeleton**: both services run and talk to each other, but no app features exist yet.

## Stack

| Piece    | Tech                                            |
| -------- | ----------------------------------------------- |
| Frontend | Next.js (App Router, TypeScript, Tailwind CSS)  |
| Backend  | FastAPI (Python)                                |
| Data     | Supabase — Postgres + Auth                      |

Auth split: the frontend owns login and session cookies via `@supabase/ssr`; the backend verifies the Supabase JWT on protected routes.

## Layout

```
FantasyPrem/
├── frontend/                   # Next.js app
│   ├── src/
│   │   ├── app/                # App Router (layout, page, globals.css)
│   │   ├── lib/
│   │   │   ├── api.ts          # typed fetch wrapper for the FastAPI backend
│   │   │   └── supabase/       # browser / server / middleware clients
│   │   └── middleware.ts       # refreshes the Supabase session
│   └── .env.local.example
├── backend/                    # FastAPI app
│   ├── app/
│   │   ├── main.py             # app factory, CORS, router registration
│   │   ├── config.py           # settings from env / .env
│   │   ├── auth.py             # Supabase JWT verification dependency
│   │   └── routers/            # health.py, hello.py
│   ├── tests/
│   ├── requirements.txt
│   └── .env.example
├── supabase/
│   ├── migrations/             # schema, applied in numerical order
│   └── README.md               # schema design notes
└── README.md
```

## Prerequisites

- Node.js 20+ and npm
- Python 3.11+
- A Supabase project (free tier is fine) — optional to get the skeleton running

## 1. Supabase setup

1. Create a project at [supabase.com](https://supabase.com).
2. Go to **Project Settings → API** and copy:
   - the **Project URL**
   - the **anon / publishable** key (safe for the browser)
   - the **service role** key (server-side only — never expose it to the browser)
3. Paste these into the env files below.

You can skip this for now. Both services boot without Supabase configured; only auth-dependent routes will be unavailable.

Then apply the schema: paste each file in `supabase/migrations/` into the Dashboard's **SQL Editor**, in numerical order. See [`supabase/README.md`](supabase/README.md) for what the tables do and why.

## 2. Backend — FastAPI

```bash
cd backend

python3 -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate

pip install -r requirements.txt    # or requirements-dev.txt for pytest + ruff
cp .env.example .env               # then fill in your Supabase values

uvicorn app.main:app --reload --port 8000
```

Runs at **http://localhost:8000**.

| Endpoint     | Notes                                    |
| ------------ | ---------------------------------------- |
| `/health`    | Liveness + whether Supabase is configured |
| `/api/hello` | Hello world                              |
| `/api/me`    | Protected — requires a Supabase JWT      |
| `/docs`      | Interactive OpenAPI docs                 |

Quick check:

```bash
curl http://localhost:8000/api/hello
```

Tests:

```bash
pip install -r requirements-dev.txt
pytest
```

## 3. Frontend — Next.js

In a second terminal:

```bash
cd frontend

npm install
cp .env.local.example .env.local   # then fill in your Supabase values

npm run dev
```

Runs at **http://localhost:3000**. The home page calls `/api/hello` on the backend and reports whether the connection succeeded — that's the end-to-end check.

Other scripts: `npm run build`, `npm run lint`, `npm run format`.

## Environment variables

**`frontend/.env.local`** — anything prefixed `NEXT_PUBLIC_` is exposed to the browser.

| Variable                        | Purpose                        |
| ------------------------------- | ------------------------------ |
| `NEXT_PUBLIC_SUPABASE_URL`      | Supabase project URL           |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Anon / publishable key         |
| `NEXT_PUBLIC_API_BASE_URL`      | FastAPI base URL               |

**`backend/.env`** — server-side only.

| Variable                    | Purpose                                                     |
| --------------------------- | ----------------------------------------------------------- |
| `ENVIRONMENT`               | `development` / `production`                                 |
| `CORS_ORIGINS`              | Comma-separated allowed origins                              |
| `SUPABASE_URL`              | Used to fetch the JWKS for token verification                |
| `SUPABASE_SERVICE_ROLE_KEY` | Privileged key — bypasses RLS, never send to the browser     |
| `SUPABASE_JWT_SECRET`       | Only for projects still on the legacy HS256 secret           |
| `DATABASE_URL`              | Postgres connection string (unused so far)                   |

## Loading Premier League data

The ingestion job pulls clubs, gameweeks, players and fixtures from the Fantasy Premier League API into Supabase.

It writes with the **service role key**, so add that to `backend/.env` first (Dashboard → Project Settings → API → `service_role`):

```
SUPABASE_SERVICE_ROLE_KEY=eyJ...
```

Then, with the backend venv active:

```bash
cd ~/FantasyPrem/backend
source .venv/bin/activate
python -m app.ingest.fpl
```

Safe to re-run — every write is an upsert keyed on the provider's id, so repeat runs refresh injuries, scores and fixture status instead of duplicating rows. Run it again whenever you want fresh data.

The endpoints are public but unofficial and undocumented; they can change shape without warning, and the terms are murky for anything commercial. Fine for building, worth revisiting before launch.

## Auth

Pages: `/login` (sign in and sign up share one form), `/dashboard` (protected), `/auth/confirm` (handles links in Supabase emails).

**For local development**, turn off email confirmation so you can sign up instantly: Supabase Dashboard → **Authentication → Sign In / Providers → Email** → disable *Confirm email*. Leave it on in production.

If you keep confirmations on, set the redirect target: **Authentication → URL Configuration** → Site URL `http://localhost:3000`, and add `http://localhost:3000/auth/confirm` to the redirect allow-list.

## How auth works

1. User signs in through Supabase in the Next.js app; `@supabase/ssr` stores the session in cookies and `middleware.ts` refreshes it.
2. The frontend reads the access token from the session and sends it to FastAPI:

   ```ts
   import { api } from "@/lib/api";
   const me = await api.get("/api/me", { accessToken });
   ```

3. FastAPI's `get_current_user` dependency verifies the JWT — against the project's JWKS endpoint by default, or the shared HS256 secret if `SUPABASE_JWT_SECRET` is set — and injects the user.

## Next steps

- League creation and joining by code
- Pick a data source for fixtures and player stats, and add an ingestion job
- Draft room (snake order, turn enforcement)
- Lineup editor with formation validation
- Scoring engine and weekly matchup settlement
