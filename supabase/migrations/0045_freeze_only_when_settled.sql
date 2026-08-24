-- 0045_freeze_only_when_settled.sql
-- The freeze in 0044 was too eager, and it swallowed a gameweek's last match.
--
-- What happened, in one ingest run: the final fixture's statistics were written,
-- refresh_gameweek_statuses saw every fixture finished and flipped the gameweek
-- to 'complete', and score_all then skipped it because "complete, and scores
-- already exist". The scores did exist — they just predated the match that had
-- only been recorded seconds earlier. Thirty-one players went unscored, and it
-- would have happened to the last match of every gameweek from then on.
--
-- "Has scores" is not the same as "has correct scores". The precise question is
-- whether our points are newer than the data they were computed from, which the
-- timestamps already answer: player_gameweek_scores.computed_at against the
-- latest player_match_stats.updated_at in that gameweek.
--
-- Still gated on 'complete' as well, deliberately. An unfinished gameweek is
-- rescored unconditionally, which is what lets a manager's edit to a deferred
-- lineup take effect — lineup changes move no statistic, so a timestamp
-- comparison alone would miss them. Once every fixture is played nobody can
-- edit anything anyway, so the two conditions together are exactly right.
--
-- One consequence worth knowing before changing a scoring value: an upsert is
-- INSERT ... ON CONFLICT DO UPDATE, so it fires the updated_at trigger even
-- when it writes identical numbers. While RESTAT_WINDOW has the ingestion
-- re-reading a fixture (twelve hours past kickoff) every run therefore pushes
-- the data timestamp forward and the gameweek keeps rescoring. The freeze
-- takes hold once those re-reads stop — roughly half a day after the final
-- match. Edit the rules before then and the change still reaches backwards.

create or replace function score_all(p_gameweek_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_league    record;
  v_leagues   integer := 0;
  v_complete  boolean;
  v_data_at   timestamptz;
  v_scored_at timestamptz;
begin
  select status = 'complete' into v_complete
    from gameweeks where id = p_gameweek_id;

  -- When the underlying statistics for this gameweek last changed. Null means
  -- nothing has been recorded yet, in which case there is nothing to freeze.
  select max(pms.updated_at) into v_data_at
    from player_match_stats pms
    join fixtures f on f.id = pms.fixture_id
   where f.gameweek_id = p_gameweek_id;

  for v_league in
    select l.id
      from leagues l
      join gameweeks g on g.season_id = l.season_id
     where g.id = p_gameweek_id
       and l.status in ('active', 'complete')
  loop
    -- max, not min: score_gameweek stamps every row it writes with a single
    -- now(), so the maximum is "when we last scored this gameweek". The
    -- minimum would be the age of the oldest surviving row, and a leftover —
    -- a player whose statistics were later removed keeps his old score row —
    -- would drag it backwards and rescore the gameweek on every cron run
    -- forever, quietly undoing the freeze.
    select max(computed_at) into v_scored_at
      from player_gameweek_scores
     where league_id = v_league.id and gameweek_id = p_gameweek_id;

    -- Settled: every match played, and these points were computed after the
    -- last statistic arrived. Rescoring could only change them, and the only
    -- thing that changes between runs then is the scoring rules — which must
    -- not reach backwards.
    if v_complete
       and v_scored_at is not null
       and v_data_at is not null
       and v_scored_at > v_data_at
    then
      continue;
    end if;

    perform score_gameweek(v_league.id, p_gameweek_id);
    v_leagues := v_leagues + 1;
  end loop;

  return v_leagues;
end;
$$;

comment on function score_all(uuid) is
  'Score a gameweek for every league in its season. Skips a league only when '
  'the gameweek is complete and its points are already newer than the latest '
  'match statistic — so corrected or late-arriving data still rescores, but a '
  'change to the scoring rules does not rewrite a settled result.';

revoke all on function score_all(uuid) from public;
grant execute on function score_all(uuid) to service_role;
