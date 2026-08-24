-- 0044_freeze_settled_gameweeks.sql
-- A finished gameweek stops being rescored.
--
-- score_gameweek recomputes from whatever scoring_rules currently say, and the
-- cron re-runs it for every active or complete gameweek. So editing a scoring
-- value rewrote history: change the price of a tackle today and last weekend's
-- results change with it.
--
-- A gameweek is frozen once both are true:
--
--   * every fixture in it has finished — which is what gameweeks.status
--     'complete' means, derived in 0038 from the fixtures themselves; and
--   * it has already been scored for that league.
--
-- Until then it keeps rescoring, which is what makes deferred fixtures work: a
-- gameweek waiting on a postponed match is 'active', not 'complete', so late
-- results still land in the gameweek they belong to.
--
-- The guard lives in score_all rather than score_gameweek because score_all is
-- twenty lines and score_gameweek is a hundred and seventy. Rewriting the
-- larger function to add four lines, with no way to test it while a live
-- gameweek is being scored, is a poor trade. score_gameweek stays callable
-- directly for a deliberate rescore.

create or replace function score_all(p_gameweek_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_league   record;
  v_leagues  integer := 0;
  v_complete boolean;
begin
  select status = 'complete' into v_complete
    from gameweeks where id = p_gameweek_id;

  for v_league in
    select l.id
      from leagues l
      join gameweeks g on g.season_id = l.season_id
     where g.id = p_gameweek_id
       and l.status in ('active', 'complete')
  loop
    -- Settled: every match played, and this league already has its points.
    -- Recomputing could only change them, and the only thing that changes
    -- between runs is the scoring rules — which must not reach backwards.
    if v_complete and exists (
      select 1 from player_gameweek_scores
       where league_id = v_league.id and gameweek_id = p_gameweek_id
    ) then
      continue;
    end if;

    perform score_gameweek(v_league.id, p_gameweek_id);
    v_leagues := v_leagues + 1;
  end loop;

  return v_leagues;
end;
$$;

comment on function score_all(uuid) is
  'Score a gameweek for every league in its season, skipping any league whose '
  'points for that gameweek are already settled — every fixture finished and '
  'points recorded. Call score_gameweek directly to force a rescore.';

revoke all on function score_all(uuid) from public;
grant execute on function score_all(uuid) to service_role;

-- ------------------------------------------------------- deliberate redo ----
-- Freezing is only safe if there's a way out of it. This is that way: an
-- explicit, commissioner-level rescore for when the rules were genuinely wrong
-- rather than merely changed.

create or replace function rescore_gameweek(p_league_id uuid, p_gameweek_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from league_commissioners
     where league_id = p_league_id and profile_id = auth.uid()
  ) and not exists (
    select 1 from leagues
     where id = p_league_id and commissioner_id = auth.uid()
  ) then
    raise exception 'Only a commissioner can rescore a settled gameweek.';
  end if;

  return score_gameweek(p_league_id, p_gameweek_id);
end;
$$;

comment on function rescore_gameweek(uuid, uuid) is
  'Recompute a settled gameweek under the current scoring rules. Changes '
  'history deliberately, so it is commissioner-only and never automatic.';

revoke all on function rescore_gameweek(uuid, uuid) from public;
grant execute on function rescore_gameweek(uuid, uuid) to authenticated, service_role;
