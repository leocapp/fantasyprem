# Database

Schema for a snake-draft, head-to-head fantasy Premier League.

## Applying the migrations

Run them **in numerical order**. Each file assumes the previous one has run.

Easiest route (no tooling to install): Supabase Dashboard → **SQL Editor** → New query → paste one file → **Run** → repeat.

```
0001_reference_data.sql     real-world football data
0002_leagues_and_draft.sql  users, leagues, teams, scoring rules, draft, rosters
0003_gameplay.sql           lineups, matchups, computed scores, transactions
0004_rls.sql                Row Level Security policies
0005_league_functions.sql   create_league / join_league, seed current season
```

If a file errors partway, fix the cause and re-run **only** that file — but note the statements before the error already committed, so you may need to drop what it created first. Starting over is always safe: Dashboard → Settings → General → **Reset database**.

## The shape of it

**Reference data** (`seasons`, `clubs`, `gameweeks`, `players`, `fixtures`, `player_match_stats`) is global and shared by every league. Users can read it; only the service role can write it. That's the table set your ingestion job fills.

**League data** (`leagues`, `fantasy_teams`, `scoring_rules`, `draft_picks`, `roster_entries`) is per league. A `fantasy_teams` row doubles as the membership record — one team per user per league.

**Gameplay** (`lineups`, `lineup_players`, `matchups`, `player_gameweek_scores`, `transactions`) is the weekly loop.

## Decisions worth knowing

**Fantasy points are never stored on `player_match_stats`.** That table holds raw performance — minutes, goals, cards. Because every league can edit its own `scoring_rules`, the same match produces different point totals in different leagues. `player_gameweek_scores` caches the computed result per league, with a `breakdown` JSON column for showing the math in the UI.

**Exclusive ownership is enforced by the database, not the API.** This partial unique index is the single most important line in the schema:

```sql
create unique index roster_entries_exclusive_ownership
  on roster_entries (league_id, player_id)
  where dropped_at is null;
```

Two managers racing to add the same free agent cannot both win, regardless of what the API does. Roster history is preserved because drops set `dropped_at` rather than deleting the row.

**New leagues get scoring rules automatically.** A trigger copies `default_scoring_rules` into `scoring_rules` on league insert. Defaults are roughly Fantasy Premier League's: 6 points for a defender's goal, 4 for a forward's, -1 per yellow, and so on. Commissioners can edit their copy without affecting anyone else.

**Joining a league needs a `SECURITY DEFINER` function.** RLS says you can only see leagues you belong to — which makes finding a league by join code impossible for the person trying to join. `join_league()` runs with elevated rights, validates the code, league status, capacity and duplicate membership itself, then inserts the team. `create_league()` is elevated for a similar reason: the league has to exist before the membership that authorises reading it.

This is the general pattern for the rest of the app. Anything that has to reach across an RLS boundary belongs in a `SECURITY DEFINER` function that does its own authorisation, not in a loosened policy.

**Standings are a view, not a table.** `league_standings` derives W/L/D and points from final matchups, so there's nothing to keep in sync.

**Some rules live in the API on purpose.** Formation validity (1 GK, 3+ DEF) depends on league settings, and draft turn order is sequential logic — neither fits a CHECK constraint. `draft_picks` deliberately has no user-facing write policy: picks go through the backend, which validates whose turn it is.

## Row Level Security

Every table has RLS enabled with a deny-by-default posture. The rule of thumb: **you can read what happens in leagues you have a team in, and write only what you own.**

Policies call `is_league_member()`, `is_league_commissioner()`, and `owns_fantasy_team()`. These are `SECURITY DEFINER` so that a policy on `fantasy_teams` can query `fantasy_teams` without recursively invoking itself.

The **service role key** bypasses RLS entirely. That's how the ingestion job writes reference data and how the scoring engine writes `player_gameweek_scores`. It must never reach the browser — backend `.env` only.

## Not built yet

- Waiver priority / FAAB budgets — `roster_entries.acquired_via` has a `waiver` value, but no claims table exists
- Trade proposal and acceptance flow (`transactions` logs completed trades only)
- Players changing clubs mid-season (`players.club_id` is current club only; a `player_club_history` table would fix it)
- Multi-season history for leagues
