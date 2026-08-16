-- reset_synthetic_gameweek.sql
--
-- Undo `python -m app.ingest.synthetic`: remove the fabricated match data and
-- everything derived from it, so the current season is unplayed again.
--
-- NOT a migration. It lives outside supabase/migrations deliberately, because
-- it is an operation rather than a schema change and must never run itself on
-- a fresh deploy.
--
-- Every statement is scoped to the CURRENT season. Last season's fixtures and
-- statistics are what the draft board is computed from — deleting those would
-- empty every ranking — so the guard matters more than it looks.
--
-- Run the whole file. It reports before and after, and rolls back on error.

begin;

-- What's about to go, so the numbers can be sanity-checked before committing.
select
  (select count(*) from player_match_stats pms
     join fixtures f on f.id = pms.fixture_id
     join seasons  s on s.id = f.season_id and s.is_current)      as fabricated_stat_rows,
  (select count(*) from fixtures f
     join seasons s on s.id = f.season_id and s.is_current
    where f.status <> 'scheduled')                                as fixtures_marked_played,
  (select count(*) from player_gameweek_scores pgs
     join gameweeks g on g.id = pgs.gameweek_id
     join seasons   s on s.id = g.season_id and s.is_current)     as league_score_rows,
  (select count(*) from matchups m
     join gameweeks g on g.id = m.gameweek_id
     join seasons   s on s.id = g.season_id and s.is_current
    where m.status <> 'scheduled')                                as matchups_settled;

-- 1. The fabricated statistics themselves.
delete from player_match_stats pms
 using fixtures f, seasons s
 where f.id = pms.fixture_id
   and s.id = f.season_id
   and s.is_current;

-- 2. Fixtures back to unplayed. The scores were invented too.
update fixtures f
   set status = 'scheduled',
       home_score = null,
       away_score = null
  from seasons s
 where s.id = f.season_id
   and s.is_current;

-- 3. Points those statistics produced, per league.
delete from player_gameweek_scores pgs
 using gameweeks g, seasons s
 where g.id = pgs.gameweek_id
   and s.id = g.season_id
   and s.is_current;

-- 4. Matchups back to unplayed, so standings are empty rather than wrong.
update matchups m
   set home_points = 0,
       away_points = 0,
       status = 'scheduled'
  from gameweeks g, seasons s
 where g.id = m.gameweek_id
   and s.id = g.season_id
   and s.is_current;

-- 5. Projections were written against a calendar that thought gameweek 1 was
--    over. They rebuild on the next run of app.ingest.projections.
delete from player_gameweek_expectations e
 using gameweeks g, seasons s
 where g.id = e.gameweek_id
   and s.id = g.season_id
   and s.is_current;

-- 6. Statuses are derived, so recomputing now that the fixtures are scheduled
--    again puts every gameweek back to 'upcoming'.
select refresh_gameweek_statuses(id) from seasons where is_current;

-- Should read: 0 stat rows, 0 played fixtures, 0 score rows, 0 settled
-- matchups, and every current gameweek 'upcoming'.
select
  (select count(*) from player_match_stats pms
     join fixtures f on f.id = pms.fixture_id
     join seasons  s on s.id = f.season_id and s.is_current)  as stat_rows_left,
  (select count(*) from fixtures f
     join seasons s on s.id = f.season_id and s.is_current
    where f.status <> 'scheduled')                            as played_fixtures_left,
  (select count(*) from player_gameweek_scores pgs
     join gameweeks g on g.id = pgs.gameweek_id
     join seasons   s on s.id = g.season_id and s.is_current) as score_rows_left,
  (select count(distinct g.status) from gameweeks g
     join seasons s on s.id = g.season_id and s.is_current)   as distinct_gameweek_statuses,
  (select min(g.status::text) from gameweeks g
     join seasons s on s.id = g.season_id and s.is_current)   as gameweek_status;

-- Last season must be untouched: ~11,487 rows across 380 fixtures.
select count(*) as last_season_stat_rows
  from player_match_stats pms
  join fixtures f on f.id = pms.fixture_id
  join seasons  s on s.id = f.season_id and not s.is_current;

commit;
