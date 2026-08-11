-- 0031_expected_goals.sql
-- Per-player expected goals, which Sportmonks reports (type 5304) and FPL
-- never did at match level.
--
-- This is the single most useful input to a projection. Goals are rare enough
-- that a handful either way is mostly luck; expected goals measure the chances
-- a player got, which is far more stable from week to week and therefore much
-- better at predicting the next match.

alter table player_match_stats
  add column if not exists expected_goals numeric(5, 3);

-- Match scores, used to derive team attacking and defensive strength. Cheap to
-- store while we're already fetching them, and it saves reconstructing team
-- goals by summing individual players.
alter table fixtures
  add column if not exists home_score integer,
  add column if not exists away_score integer;
