# Deployment

Frontend on **Vercel**, database on **Supabase**, scheduled jobs on **GitHub
Actions**, domain from **Cloudflare**. No backend server is deployed: FastAPI
stays a local development tool, and the Python that matters runs on a schedule.

## Why there's no backend to deploy

Every real operation — drafting, trades, scoring, lineups, chat — is a Postgres
function called from Next.js, protected by RLS. FastAPI only ever served demo
endpoints. What genuinely needs to run is the ingestion and scoring scripts, and
those need a scheduler rather than a web server.

Keep `backend/` — it's how the jobs run, and it's where server-side logic would
go if you ever need it.

---

## 1. Before deploying

- [ ] `cd frontend && npm run build` — passes.
- [ ] `cd frontend && npm run lint` — passes.
- [ ] `git ls-files | grep env` — only `.example` files listed.
- [ ] Delete `frontend/src/app/leagues/[id]/draft/DraftRealtime.tsx` if still present.
- [ ] Apply migrations `0020` and `0021` if you haven't.
- [ ] Fix the placeholder season dates in `seasons`, or let the ingestion job
      correct them.
- [ ] Decide whether to start a clean league. Your current data contains
      fabricated match stats from `app.ingest.synthetic`.

## 2. Supabase

- [ ] **Re-enable email confirmation** — Authentication → Sign In / Providers →
      Email. Off since local development, which lets anyone sign up as any address.
- [ ] **URL configuration** — set Site URL to `https://<your-domain>` and add
      both `https://<your-domain>/auth/callback` and
      `https://<your-domain>/auth/confirm` to the redirect allow-list.
- [ ] **Google OAuth** — add the production callback in Google Cloud Console too.
- [ ] Confirm RLS is on everywhere:
      `select tablename, rowsecurity from pg_tables where schemaname = 'public';`

## 3. Vercel

Import the GitHub repo, then:

- **Root directory:** `frontend`
- **Framework preset:** Next.js (detected automatically)
- **Environment variables:**
  - `NEXT_PUBLIC_SUPABASE_URL`
  - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
  - `NEXT_PUBLIC_SITE_URL` — your production URL, used as the OAuth redirect
    fallback
  - `TZ=Europe/London` — see Timezones below

Do **not** add the service role key. It bypasses RLS and nothing in the frontend
needs it.

Every branch gets a preview URL. Add those preview domains to Supabase's
redirect allow-list if you want to test sign-in on them.

## 4. Domain (Cloudflare)

1. Buy the domain in Cloudflare (registrar → sold at cost, ~$10–15/year).
2. In Vercel: Project → Settings → Domains → add your domain.
3. Vercel shows the DNS records to create; add them in Cloudflare.
4. Set those records to **DNS only** (grey cloud) rather than proxied — Vercel
   terminates TLS itself, and proxying both ends causes redirect loops.
5. Update Supabase's Site URL and redirect allow-list to the real domain.

## 5. Scheduled jobs (GitHub Actions)

`.github/workflows/scheduled.yml` runs hourly and on demand. It refreshes squads
and fixtures, ingests match stats, scores every league, and settles trades whose
veto window has closed.

Add two repository secrets — Settings → Secrets and variables → Actions:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Then trigger it by hand from the Actions tab once to confirm it works before
relying on the schedule.

The same command runs locally:

```bash
cd backend && source .venv/bin/activate && python -m app.ingest.cron
```

## Timezones

Server components render dates in the server's timezone — UTC on Vercel by
default, which would show a 15:30 kickoff as 14:30 to a UK reader in summer.
Setting `TZ=Europe/London` in Vercel fixes it while everyone is in one timezone.
Doing it properly means rendering those timestamps client-side.

## Making changes after launch

Code is easy: push to git, Vercel rebuilds. Database changes need more care once
real seasons exist.

- **Additive changes** — new tables, columns, functions — stay as easy as they
  have been.
- **Destructive changes**, like migration 0014 renaming columns, deserve a
  staging environment: a second free Supabase project with the same schema.
- `reset_league` is no longer a debugging tool once other people's seasons live
  in the database.

## Known gaps

- No auto-substitutions. A starter who doesn't play scores zero; the bench
  doesn't cover. Carry-forward lineups (0020) soften the worst case.
- No rate limiting on league creation or chat.
- The FPL API is unofficial and undocumented; it can change shape without notice
  and its terms are unclear for commercial use.
- No email notifications — draft turns, trade offers and veto windows are only
  visible in the app.
- Vercel's Hobby plan prohibits commercial use. Fine for a friends' league; if
  this ever makes money, that's a Pro plan at $20/month.
