-- 0035_season_stats_extended.sql
-- The six stats added in 0028 were never carried into the season totals.
--
-- They've been collected per match since then, and scored per match, but the
-- player page could only ever show a season figure for the stats that existed
-- before them. Duels won and big chances created are exactly the sort of thing
-- you want a season number for, so they go into the view.
--
-- Appended rather than dropped and recreated: `create or replace view` refuses
-- to remove or reorder columns but is happy to add them at the end, and every
-- existing column here keeps its position.

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
  -- Added in 0035. Null-safe because these columns were backfilled onto rows
  -- that predate them, where they are genuinely unknown rather than zero.
  coalesce(sum(pms.shots_on_target), 0)     as shots_on_target,
  coalesce(sum(pms.key_passes), 0)          as key_passes,
  coalesce(sum(pms.tackles), 0)             as tackles,
  coalesce(sum(pms.interceptions), 0)       as interceptions,
  coalesce(sum(pms.big_chances_created), 0) as big_chances_created,
  coalesce(sum(pms.duels_won), 0)           as duels_won,
  coalesce(sum(pms.own_goals), 0)           as own_goals,
  coalesce(sum(pms.penalties_saved), 0)     as penalties_saved,
  coalesce(sum(pms.penalties_missed), 0)    as penalties_missed
from player_match_stats pms
join fixtures f on f.id = pms.fixture_id
-- Deliberately not filtered on f.status. A stats row exists only because a
-- match was played, so the status adds nothing — and it's rewritten from the
-- provider on every ingestion run, which would silently empty this view
-- whenever the calendar disagreed with what had actually been recorded.
group by pms.player_id, f.season_id;

alter view player_season_stats set (security_invoker = on);

grant select on player_season_stats to authenticated;
