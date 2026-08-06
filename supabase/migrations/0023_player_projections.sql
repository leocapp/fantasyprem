-- 0023_player_projections.sql
-- Projections and underlying performance metrics from the FPL feed.
--
-- IMPORTANT: ep_next is FPL's expected points for the coming gameweek, scored
-- by FPL's own rules — not this league's. A league paying 6 for a forward's
-- goal where FPL pays 4 will find it systematically low. It's a form guide, not
-- a prediction of what a player will score here, and the UI labels it as FPL's.
--
-- The per-90 expected goals and assists are the raw material for a
-- league-specific projection later, if one is ever worth building.

alter table players
  add column if not exists ep_next          numeric(6, 2),
  add column if not exists form             numeric(6, 2),
  add column if not exists points_per_game  numeric(6, 2),
  add column if not exists xg_per_90        numeric(6, 3),
  add column if not exists xa_per_90        numeric(6, 3),
  add column if not exists xgi_per_90       numeric(6, 3),
  add column if not exists xgc_per_90       numeric(6, 3);

-- Sorting a full player list by projection is the main use, so index it.
create index if not exists players_ep_next_idx
  on players (ep_next desc nulls last)
  where is_active;
