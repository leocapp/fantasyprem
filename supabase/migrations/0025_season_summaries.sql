-- 0025_season_summaries.sql
-- Season totals for a player: what they did, and what it was worth here.
--
-- Two views because they answer different questions. Real stats are the same
-- for everyone; fantasy points depend on the league's scoring rules. Keeping
-- them apart is also why a striker with eight goals can sit behind a defender
-- in one league and ahead of them in another.
--
-- Aggregated in the database rather than the app: PostgREST's support for
-- aggregate functions is version-dependent and easy to break, and Postgres
-- summing a few thousand rows is faster than shipping them to Next.js.

-- ------------------------------------------------------ real performance ----

create or replace view player_season_stats as
select
  pms.player_id,
  f.season_id,
  count(*) filter (where pms.minutes > 0)   as appearances,
  count(*) filter (where pms.minutes >= 60) as full_games,
  coalesce(sum(pms.minutes), 0)             as minutes,
  coalesce(sum(pms.goals), 0)               as goals,
  coalesce(sum(pms.assists), 0)             as assists,
  count(*) filter (where pms.clean_sheet)   as clean_sheets,
  coalesce(sum(pms.goals_conceded), 0)      as goals_conceded,
  coalesce(sum(pms.saves), 0)               as saves,
  coalesce(sum(pms.yellow_cards), 0)        as yellow_cards,
  coalesce(sum(pms.red_cards), 0)           as red_cards,
  coalesce(sum(pms.bonus), 0)               as bonus
from player_match_stats pms
join fixtures f on f.id = pms.fixture_id
-- Deliberately not filtered on f.status. A stats row exists only because a
-- match was played, so the status adds nothing — and it's rewritten from the
-- live FPL feed on every ingestion run, which would silently empty this view
-- whenever the calendar disagreed with what had actually been recorded.
group by pms.player_id, f.season_id;

alter view player_season_stats set (security_invoker = on);

-- ---------------------------------------------------- fantasy points ----
-- gameweeks_elapsed counts every completed gameweek in the season, not just
-- the ones this player scored in. Per-game averages therefore include weeks
-- they missed — deliberate, because owning an injured player costs you those
-- weeks. `appearances` sits alongside it so the reason is visible.

create or replace view player_league_season_points as
select
  s.league_id,
  s.player_id,
  coalesce(sum(s.points), 0) as total_points,
  max(s.points)              as best_gameweek,
  count(*)                   as gameweeks_scored,
  elapsed.gameweeks_elapsed
from player_gameweek_scores s
join leagues l on l.id = s.league_id
join lateral (
  select count(*) as gameweeks_elapsed
    from gameweeks g
   where g.season_id = l.season_id
     and g.status = 'complete'
) elapsed on true
group by s.league_id, s.player_id, elapsed.gameweeks_elapsed;

alter view player_league_season_points set (security_invoker = on);
