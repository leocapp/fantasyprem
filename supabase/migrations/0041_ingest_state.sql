-- 0041_ingest_state.sql
-- When each slow-moving part of the ingestion last ran.
--
-- The scheduled job refreshes everything on every run, but the things it
-- fetches move at very different speeds. Scores and fixture statuses change
-- minute by minute during a match. Squads change during a transfer window;
-- injuries change daily at most. Fetching all of it every twenty minutes cost
-- 320 seconds of a 469-second run — forty requests to answer a question whose
-- answer almost never changes.
--
-- One row per kind of work, holding when it last completed. Deliberately a
-- table rather than inferring it from max(players.updated_at): that would be
-- true today and quietly wrong the moment anything else touches a player row.

create table if not exists ingest_state (
  key    text primary key,
  ran_at timestamptz not null default now()
);

comment on table ingest_state is
  'When each slow-moving ingestion step last completed, so it can run on its '
  'own cadence rather than on every scheduled run.';

alter table ingest_state enable row level security;

-- Only the service role reads or writes this, and nothing in the app needs it,
-- so there are deliberately no policies.
