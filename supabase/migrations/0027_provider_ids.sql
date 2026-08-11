-- 0027_provider_ids.sql
-- Room for a second data provider alongside FPL.
--
-- One row per real-world thing, with a column per provider's id — rather than
-- one row per provider. Two rows for the same player would mean every list in
-- the app needs to know which provider is active, and rosters would break the
-- moment the active provider changed.
--
-- This way a trial can ingest Sportmonks data beside the FPL data with no
-- effect on the running site, and switching providers later is a change to the
-- ingestion layer only. Reverting is dropping these columns.

alter table clubs    add column if not exists sportmonks_id text unique;
alter table players  add column if not exists sportmonks_id text unique;
alter table fixtures add column if not exists sportmonks_id text unique;

-- Where a player's Sportmonks id came from: 'exact' for a confident match on
-- name, club and date of birth, 'manual' for one resolved by hand, null while
-- unmatched. Matching across providers is the genuinely hard part of a switch,
-- and it needs to be auditable rather than silent.
alter table players
  add column if not exists sportmonks_match_confidence text
  check (sportmonks_match_confidence in ('exact', 'likely', 'manual'));

-- Date of birth is the tiebreaker when two players share a name. FPL doesn't
-- publish it; Sportmonks does, so it fills in as matches are made.
alter table players add column if not exists date_of_birth date;

create index if not exists players_unmatched_idx
  on players (id)
  where sportmonks_id is null and is_active;
