-- 0053_playoff_settings.sql
-- Stage one of the playoffs: settings, the shape of the schedule, and keeping
-- the two trophies apart. No bracket yet — that's the next migration.
--
-- The season splits in two. A regular season decides the league title on record
-- alone, and a bracket over the closing gameweeks decides the playoff title.
-- Both have to matter through week 38, which means playoff results must never
-- touch the standings — otherwise a deep run rewrites a race that was already
-- settled.
--
-- One number configures the whole thing. Rounds, byes and the length of the
-- regular season all derive from playoff_teams:
--
--   7 teams  ->  bracket of 8, one bye   -> seed 1 rests, 2v7 3v6 4v5
--   6 teams  ->  bracket of 8, two byes  -> seeds 1 and 2 rest, last place out
--   4 teams  ->  bracket of 4, no byes   -> two rounds
--   0        ->  no playoffs at all
--
-- So "bye for the top seed" and "last place misses out" are not two modes. They
-- are 7 and 6.

-- ------------------------------------------------------------- settings ----

alter table leagues
  add column if not exists playoff_teams integer not null default 0,
  add column if not exists consolation   boolean not null default true;

alter table leagues
  drop constraint if exists leagues_playoff_teams_sane;

-- Zero means off. Two is the smallest bracket that is a bracket. The upper
-- bound is checked in the helper below rather than here, because it depends on
-- how many teams have actually joined.
alter table leagues
  add constraint leagues_playoff_teams_sane
  check (playoff_teams = 0 or playoff_teams between 2 and 32);

comment on column leagues.playoff_teams is
  'How many teams reach the bracket. 0 disables playoffs entirely. Rounds, '
  'byes and the length of the regular season are all derived from this.';

comment on column leagues.consolation is
  'Whether eliminated teams keep playing each other during the playoff weeks. '
  'With an odd number left over, the spare team plays the league average.';

-- ---------------------------------------------------------------- rounds ----
-- A lookup rather than ceil(log(2, n)). The arithmetic is right but it runs
-- through floating point, and a log that returns 2.0000000001 for four teams
-- would quietly cost a league a week of its regular season. Nobody is running a
-- thirty-two team bracket in this app.

create or replace function playoff_rounds(p_teams integer)
returns integer
language sql
immutable
as $$
  select case
           when coalesce(p_teams, 0) <= 1 then 0
           when p_teams <= 2  then 1
           when p_teams <= 4  then 2
           when p_teams <= 8  then 3
           when p_teams <= 16 then 4
           else 5
         end;
$$;

comment on function playoff_rounds(integer) is
  'Rounds needed for a bracket of this size, padding to the next power of two.';

-- ------------------------------------------------- where the season ends ----

create or replace function regular_season_end(p_league_id uuid)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select max(g.number) - playoff_rounds(l.playoff_teams)
    from leagues l
    join gameweeks g on g.season_id = l.season_id
   where l.id = p_league_id
   group by l.playoff_teams;
$$;

comment on function regular_season_end(uuid) is
  'Last gameweek of the regular season. With playoffs off this is simply the '
  'final gameweek of the season.';

revoke all on function regular_season_end(uuid) from public;
grant execute on function regular_season_end(uuid) to authenticated, service_role;

-- ------------------------------------------------------ matchup staging ----
-- Reusing matchups rather than building a parallel playoff table. Scoring,
-- settle_matchups, team_gameweek_points, the matchup page and the live badge
-- all keep working untouched; a bracket game is an ordinary fixture that
-- happens to know which round it belongs to.

alter table matchups
  add column if not exists stage        text not null default 'regular',
  add column if not exists round        integer,
  add column if not exists bracket_slot integer;

alter table matchups
  drop constraint if exists matchups_stage_known;

alter table matchups
  add constraint matchups_stage_known
  check (stage in ('regular', 'playoff', 'consolation'));

create index if not exists matchups_stage_idx
  on matchups (league_id, stage);

comment on column matchups.stage is
  'regular counts towards the standings; playoff and consolation do not.';

-- ------------------------------------------------------ league standings ----
-- The whole point of the split. A playoff run must not be able to rewrite a
-- league title that was already decided on record.

create or replace view league_standings as
with results as (
  select league_id, home_team_id as team_id, home_points as points_for,
         away_points as points_against, status
    from matchups
   where stage = 'regular'
   union all
  select league_id, away_team_id, away_points, home_points, status
    from matchups
   where stage = 'regular' and away_team_id is not null
)
select
  league_id,
  team_id,
  count(*) filter (where status = 'final')                                as games_played,
  count(*) filter (where status = 'final' and points_for > points_against) as wins,
  count(*) filter (where status = 'final' and points_for < points_against) as losses,
  count(*) filter (where status = 'final' and points_for = points_against) as draws,
  coalesce(sum(points_for) filter (where status = 'final'), 0)             as points_for,
  coalesce(sum(points_against) filter (where status = 'final'), 0)         as points_against
from results
group by league_id, team_id;

alter view league_standings set (security_invoker = on);

grant select on league_standings to authenticated;

-- ----------------------------------------------------- generate schedule ----
-- 0010's definition, stopping at the regular season end instead of running to
-- the last gameweek of the season.
--
-- The rotation is untouched, and that matters: the circle method produces the
-- same first N weeks whether you generate 35 of them or 38. Shortening a season
-- is therefore a truncation, not a reshuffle, and nobody's already-played
-- fixtures move.

create or replace function generate_schedule(p_league_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_season_id uuid;
  v_teams     uuid[];
  v_size      integer;
  v_round     integer := 0;
  v_created   integer := 0;
  v_last      integer;
  v_gameweek  record;
  v_home      uuid;
  v_away      uuid;
  i           integer;
begin
  select season_id into v_season_id from leagues where id = p_league_id;

  if v_season_id is null then
    raise exception 'League not found.';
  end if;

  if exists (select 1 from matchups where league_id = p_league_id and status = 'final') then
    raise exception 'This league already has settled results.';
  end if;

  v_last := regular_season_end(p_league_id);

  select array_agg(id order by draft_position nulls last, created_at)
    into v_teams
    from fantasy_teams
   where league_id = p_league_id;

  v_size := coalesce(array_length(v_teams, 1), 0);

  if v_size < 2 then
    raise exception 'A schedule needs at least two teams.';
  end if;

  -- Odd team count: add a phantom team so someone sits out each week.
  if v_size % 2 = 1 then
    v_teams := v_teams || array[null]::uuid[];
    v_size := v_size + 1;
  end if;

  delete from matchups where league_id = p_league_id;

  for v_gameweek in
    select id, number from gameweeks
     where season_id = v_season_id and number <= v_last
     order by number
  loop
    for i in 1 .. (v_size / 2) loop
      v_home := v_teams[i];
      v_away := v_teams[v_size + 1 - i];

      -- Alternate sides each round so home and away even out.
      if v_round % 2 = 1 then
        select v_away, v_home into v_home, v_away;
      end if;

      if v_home is null then
        v_home := v_away;
        v_away := null;
      end if;

      if v_home is not null then
        insert into matchups (league_id, gameweek_id, home_team_id, away_team_id, stage)
        values (p_league_id, v_gameweek.id, v_home, v_away, 'regular');
        v_created := v_created + 1;
      end if;
    end loop;

    -- Rotate everything except the first slot.
    v_teams := v_teams[1:1] || v_teams[v_size:v_size] || v_teams[2:v_size - 1];
    v_round := v_round + 1;
  end loop;

  return v_created;
end;
$$;

revoke all on function generate_schedule(uuid) from public;
grant execute on function generate_schedule(uuid) to authenticated;

-- --------------------------------------------------- trimming mid-season ----
-- Turning playoffs on after a league has started shortens the regular season,
-- which means deleting fixtures at the end of it. generate_schedule refuses to
-- run at all once anything is final, correctly — so this is the narrower
-- operation: drop the tail, keep everything that has been played or is still
-- coming inside the new window.
--
-- Safe now and genuinely dangerous later. Do it in week two, not in March.

create or replace function trim_schedule_for_playoffs(p_league_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_last    integer;
  v_settled integer;
  v_removed integer;
begin
  if not exists (
    select 1 from league_commissioners
     where league_id = p_league_id and profile_id = auth.uid()
  ) and not exists (
    select 1 from leagues where id = p_league_id and commissioner_id = auth.uid()
  ) then
    raise exception 'Only a commissioner can change the schedule.';
  end if;

  v_last := regular_season_end(p_league_id);

  if v_last is null then
    raise exception 'League not found.';
  end if;

  -- A played fixture is a result someone owns. If the new regular season would
  -- end before a week that has already been settled, that is a mistake to stop
  -- rather than to absorb.
  select count(*) into v_settled
    from matchups m
    join gameweeks g on g.id = m.gameweek_id
   where m.league_id = p_league_id
     and m.stage = 'regular'
     and m.status = 'final'
     and g.number > v_last;

  if v_settled > 0 then
    raise exception
      'Gameweek % onwards has % settled result(s). Shortening the season now would erase them.',
      v_last + 1, v_settled;
  end if;

  delete from matchups m
   using gameweeks g
   where g.id = m.gameweek_id
     and m.league_id = p_league_id
     and m.stage = 'regular'
     and g.number > v_last;

  get diagnostics v_removed = row_count;
  return v_removed;
end;
$$;

comment on function trim_schedule_for_playoffs(uuid) is
  'Drop regular-season matchups that fall beyond the regular season end, to '
  'make room for the bracket. Refuses if any of them have been played.';

revoke all on function trim_schedule_for_playoffs(uuid) from public;
grant execute on function trim_schedule_for_playoffs(uuid) to authenticated;

-- -------------------------------------------------------------- verify ----

do $$
declare
  v_league record;
begin
  for v_league in
    select l.id, l.name, l.playoff_teams,
           regular_season_end(l.id) as ends,
           (select count(*) from fantasy_teams ft where ft.league_id = l.id) as teams
      from leagues l
     where l.status in ('active', 'drafting')
  loop
    if v_league.playoff_teams > v_league.teams then
      raise warning
        '% has playoff_teams = % but only % teams.',
        v_league.name, v_league.playoff_teams, v_league.teams;
    end if;

    raise notice
      '% — playoff_teams %, regular season ends at gameweek %',
      v_league.name, v_league.playoff_teams, v_league.ends;
  end loop;
end $$;
