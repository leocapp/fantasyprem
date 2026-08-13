-- 0038_gameweek_status.sql
-- Derive gameweek status from the fixtures instead of never setting it.
--
-- gameweeks.status has been stuck on 'upcoming' since the Sportmonks switch.
-- The FPL ingestion computed it from that provider's flags; the replacement
-- writes the literal 'upcoming' for every gameweek, and because it upserts on
-- (season_id, number) it also overwrites the existing rows on every hourly run.
-- So even a hand-set 'complete' would survive less than an hour.
--
-- Nothing errored. It just meant the scoring step — which asks for gameweeks
-- where status = 'complete' — always got an empty list, so no gameweek would
-- ever have been scored, no matchup resolved and no standings moved. Invisible
-- until the first gameweek finishes, which is the worst possible time to find
-- out.
--
-- Status belongs here rather than in the ingestion: it's derivable from
-- fixtures we already hold, and putting it in the database means it can't be
-- clobbered by the next upsert.

create or replace function refresh_gameweek_statuses(p_season_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_changed integer;
begin
  with state as (
    select
      g.id,
      case
        -- No fixtures yet: nothing to be active or complete about.
        when count(f.id) = 0 then 'upcoming'

        -- Every match played. A postponed fixture is rescheduled with a new
        -- kickoff and stays 'scheduled', so a gameweek waiting on one stays
        -- active rather than completing early and freezing a wrong result.
        when count(f.id) filter (where f.status = 'finished') = count(f.id)
          then 'complete'

        -- Anything kicked off makes the gameweek live, which is what drives
        -- in-progress matchup scores.
        when count(f.id) filter (where f.kickoff_at <= now()) > 0
          then 'active'

        else 'upcoming'
      end::gameweek_status as derived
    from gameweeks g
    left join fixtures f on f.gameweek_id = g.id
    where g.season_id = p_season_id
    group by g.id
  )
  update gameweeks g
     set status = s.derived
    from state s
   where s.id = g.id
     and g.status is distinct from s.derived;

  get diagnostics v_changed = row_count;
  return v_changed;
end;
$$;

comment on function refresh_gameweek_statuses(uuid) is
  'Recompute gameweeks.status from their fixtures. Call after ingesting '
  'fixtures. The ingestion must not write status itself — it upserts, and '
  'would overwrite this on the next run.';

revoke all on function refresh_gameweek_statuses(uuid) from public;
grant execute on function refresh_gameweek_statuses(uuid) to service_role;

-- Correct what's there now, so the fix doesn't wait for the next ingest.
do $$
declare
  v_season uuid;
begin
  for v_season in select id from seasons loop
    perform refresh_gameweek_statuses(v_season);
  end loop;
end $$;
