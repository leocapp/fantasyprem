-- 0039_restore_past_season_fixtures.sql
-- Put last season's fixtures back on last season.
--
-- All 380 of them were rewritten in a single minute onto the current season
-- and its gameweeks, so every 2026/27 gameweek held one finished match from
-- 2025/26 alongside its own unplayed one. Consequences, none of which errored:
--
--   * refresh_gameweek_statuses saw a finished fixture in every gameweek, so
--     the whole season read 'active' and could never complete.
--   * recompute_draft_values picks its season with `where not s.is_current`,
--     which matched no fixtures at all — draft rankings and last season's stat
--     tables were about to empty on the next run.
--
-- The mapping back is unambiguous. These fixtures are last season's by date,
-- and the gameweek they were parked on still carries the round number the
-- backfill derived, so each returns to the 2025/26 gameweek of the same number.
-- player_match_stats reference fixture ids, which don't change, so the stats
-- follow without being touched.

do $$
declare
  v_current   uuid;
  v_starts_on date;
  v_past      uuid;
  v_moved     integer;
  v_stranded  integer;
begin
  select id, starts_on into v_current, v_starts_on
    from seasons where is_current limit 1;

  select id into v_past
    from seasons where not is_current order by ends_on desc limit 1;

  if v_current is null or v_past is null then
    raise exception 'Need both a current and a past season; found current=% past=%',
      v_current, v_past;
  end if;

  update fixtures f
     set season_id   = v_past,
         gameweek_id = pg.id
    from gameweeks cg
    join gameweeks pg
      on pg.season_id = v_past
     and pg.number = cg.number
   where f.gameweek_id = cg.id
     and cg.season_id = v_current
     and f.season_id = v_current
     -- Kickoff is the discriminator: anything before this season began cannot
     -- belong to it, whatever the row currently claims.
     and f.kickoff_at < v_starts_on;

  get diagnostics v_moved = row_count;
  raise notice 'Moved % fixture(s) back to the previous season', v_moved;

  -- A fixture must sit on a gameweek from its own season. This is the
  -- invariant that was violated, so it's worth checking rather than assuming
  -- the update covered everything.
  select count(*) into v_stranded
    from fixtures f
    join gameweeks g on g.id = f.gameweek_id
   where g.season_id is distinct from f.season_id;

  if v_stranded > 0 then
    raise exception
      'Aborting: % fixture(s) still sit on a gameweek from another season.',
      v_stranded;
  end if;
end $$;

-- Statuses were derived from the wrong fixtures, so redo them.
do $$
declare
  v_season uuid;
begin
  for v_season in select id from seasons loop
    perform refresh_gameweek_statuses(v_season);
  end loop;
end $$;

-- ------------------------------------------------------ keep it that way ----
-- Cheap, and it turns a silent data migration into an immediate failure.

create or replace function fixture_season_matches_gameweek()
returns trigger
language plpgsql
as $$
declare
  v_gameweek_season uuid;
begin
  if new.gameweek_id is null then
    return new;
  end if;

  select season_id into v_gameweek_season from gameweeks where id = new.gameweek_id;

  if v_gameweek_season is distinct from new.season_id then
    raise exception
      'Fixture % is in season % but its gameweek belongs to season %',
      new.sportmonks_id, new.season_id, v_gameweek_season;
  end if;

  return new;
end;
$$;

drop trigger if exists fixtures_season_consistent on fixtures;

create trigger fixtures_season_consistent
  before insert or update of season_id, gameweek_id on fixtures
  for each row execute function fixture_season_matches_gameweek();

comment on function fixture_season_matches_gameweek() is
  'A fixture and its gameweek must belong to the same season. Violating this '
  'silently made a whole season unscoreable and emptied the draft rankings; '
  'failing loudly is much cheaper than finding it again.';
