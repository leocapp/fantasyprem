-- 0052_player_club_changes.sql
-- Real-world transfers, derived from what we already fetch.
--
-- The squad refresh rewrites every player's club_id every six hours and throws
-- the previous value away. Keeping it instead gives three things without a
-- single extra API call:
--
--   moved    club_id changed between refreshes — both ends known
--   arrived  a sportmonks_id we have never seen — a signing from another league
--   left     was active, no longer appears in any squad — the Casemiro case
--
-- No fees, no loan-versus-permanent, no announcement date. This is "what we
-- observed", not a transfer feed, and it lags by up to six hours. If the
-- Sportmonks transfers endpoint turns out to be on the plan, that becomes a
-- richer source and this table is where it would land anyway.

create table if not exists player_club_changes (
  id           uuid primary key default gen_random_uuid(),
  player_id    uuid not null references players (id) on delete cascade,
  from_club_id uuid references clubs (id) on delete set null,
  to_club_id   uuid references clubs (id) on delete set null,
  kind         text not null check (kind in ('moved', 'arrived', 'left')),
  seen_at      timestamptz not null default now()
);

create index if not exists player_club_changes_recent
  on player_club_changes (seen_at desc);

-- One row per distinct move, ever.
--
-- A player caught mid-transfer appears in both squads at once, and dedupe()
-- keeps whichever listing came last — so without this he could ping-pong
-- between two clubs every six hours and generate a "transfer" each time.
--
-- NULLS NOT DISTINCT matters and is easy to miss: from_club_id is null for an
-- arrival and to_club_id is null for a departure, and by default Postgres treats
-- every null as unique, so the constraint would silently not apply to exactly
-- the rows most likely to repeat. This project has already been caught by that
-- once.
create unique index if not exists player_club_changes_once
  on player_club_changes (player_id, from_club_id, to_club_id, kind)
  nulls not distinct;

alter table player_club_changes enable row level security;

-- Reference data about the real world, not about anyone's league, so every
-- signed-in user can read it. Only the ingestion writes.
create policy player_club_changes_read
  on player_club_changes for select to authenticated
  using (true);

grant select on player_club_changes to authenticated;
