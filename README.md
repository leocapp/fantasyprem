# FatBoysFantasy

Fantasy Premier League with a snake draft and weekly head-to-head matchups.
Draft a squad of real players, set a starting XI each gameweek, and score points
from what actually happens on the pitch.

Live at **[fatboysfantasy.com](https://fatboysfantasy.com)**.

## What it does

- **Snake draft** — live draft room, turn order enforced by the database, squad
  composition rules checked as you pick
- **Weekly lineups** — pick an XI on a pitch view with formations, captain and
  vice-captain, injury flags and fixture context
- **Real scoring** — per-player points from actual match performances, using
  each league's own configurable scoring rules
- **Head-to-head** — a full season schedule, standings, and per-matchup detail
  showing every player's contribution
- **Squad management** — free agent swaps and multi-player trades with a league
  veto window
- **League life** — chat, manager profiles with avatars, commissioner settings

## Stack

| Piece | Tech |
| --- | --- |
| Frontend | Next.js (App Router, TypeScript, Tailwind) on Vercel |
| Data & auth | Supabase — Postgres, Row Level Security, Realtime, Storage |
| Scheduled jobs | Python on GitHub Actions |

**There is no backend server in production.** Every operation — drafting,
trades, scoring, lineups — is a Postgres function called from Next.js and
protected by RLS. The `backend/` directory holds the ingestion and scoring
scripts, which run on a schedule rather than behind an HTTP server.

## How it fits together

The database is the source of truth for rules, not the app. Turn order, squad
minimums, trade legality, scoring and deadlines are all enforced in Postgres, so
a stale browser tab or a hand-crafted request can't produce an illegal state.
The UI's job is to make the legal moves obvious.

Three consequences worth knowing:

- **Changing scoring rules is data, not code** — each league gets its own copy
  of the rules at creation, editable from league settings.
- **RLS is the authorisation layer.** Chat, for instance, has no server function
  at all: the insert policy pins the author to `auth.uid()`, so the browser can
  write directly.
- **Anything crossing an RLS boundary is a `SECURITY DEFINER` function** that
  does its own checks — joining a league by code, for example, since you can't
  see a league you haven't joined.

Schema design notes are in [`supabase/README.md`](supabase/README.md).

## Layout

```
FantasyPrem/
├── frontend/                 # Next.js app (deployed to Vercel)
│   └── src/
│       ├── app/              # routes: leagues, draft, team, trades, chat…
│       ├── components/       # shared UI
│       └── lib/              # Supabase clients, date helpers
├── backend/                  # Python data jobs (not deployed as a server)
│   └── app/ingest/
│       ├── fpl.py            # clubs, players, gameweeks, fixtures
│       ├── stats.py          # match stats, then scores every league
│       ├── synthetic.py      # fabricated stats for off-season testing
│       └── cron.py           # all of the above, for the scheduler
├── supabase/migrations/      # schema, applied in numerical order
└── .github/workflows/        # hourly ingestion and scoring
```

## Running it locally

Day to day you only need the frontend — Supabase is hosted.

```bash
cd frontend && npm install && npm run dev
```

Open http://localhost:3000. Requires `frontend/.env.local`:

```
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
```

Before pushing, always:

```bash
npm run build
```

The dev server tolerates type and lint errors that a production build rejects.

## Data jobs

Python 3.12, with `backend/.env` holding `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY` (server-side only — it bypasses RLS).

```bash
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

python -m app.ingest.cron        # everything, as the scheduler runs it
python -m app.ingest.fpl         # refresh squads and fixtures
python -m app.ingest.stats       # match stats and scoring
python -m app.ingest.synthetic 3 # fabricate one gameweek (development only)
```

In production these run hourly via GitHub Actions, so points appear within an
hour of a match finishing.

Data comes from the Fantasy Premier League API, which is public but unofficial
and undocumented.

## Deploying

Push to `main` and Vercel builds and deploys. Migrations are applied by hand
through the Supabase SQL editor, in numerical order.

Full setup and the pre-launch checklist are in [`DEPLOY.md`](DEPLOY.md).

## Transfer windows

Players who leave the Premier League disappear from the FPL feed. The ingestion
job marks anyone missing as inactive rather than deleting them — history and
roster entries survive, and a player FPL drops and re-adds simply flips back.

An inactive player stays on the roster that owns them, flagged as gone and
excluded from free agency, so the manager decides what to do rather than being
silently left short. New arrivals need no handling: they're upserted on the
provider's id and appear in free agents automatically.

## Known gaps

- No auto-substitutions — a starter who doesn't play scores zero. Carry-forward
  lineups soften the worst case.
- No notifications; draft turns and trade offers are only visible in the app.
- Google sign-in shows the Supabase project domain on the consent screen,
  which needs either Google brand verification or a paid custom domain.
- Timestamps render in a fixed timezone (`src/lib/datetime.ts`) rather than the
  reader's.
