-- 0056_playoffs_run_alongside.sql
-- The bracket runs beside the regular season, not after it.
--
-- 0053 and 0054 split the season in two: thirty-five weeks of league, then a
-- three-week bracket. That was wrong about what was wanted. The league title
-- should still be decided on the final day, so every gameweek counts towards
-- the table — and the bracket is played over the closing weeks using the same
-- scores. One lineup, one total, read into two competitions.
--
-- It is a better design than the one it replaces, and mostly by deletion:
--
--   * nobody has a dead week, because everyone still has a league fixture;
--   * the consolation bracket is therefore unnecessary and goes;
--   * no fixtures are deleted, so trim_schedule_for_playoffs goes too;
--   * the title and the trophy are decided on the same afternoon.
--
-- The cost, which is worth stating out loud because it will come up in April:
-- seeds freeze before the bracket starts, but the table keeps moving. Whoever
-- leads after week 35 gets the top seed; whoever leads after 38 wins the
-- league. They need not be the same manager.

-- ------------------------------------------------ two games in one week ----
-- A team now appears twice in a playoff gameweek: once in its league fixture
-- and once in the bracket. The old indexes made that impossible.

drop index if exists matchups_home_slot;
drop index if exists matchups_away_slot;

create unique index matchups_home_slot
  on matchups (league_id, gameweek_id, stage, home_team_id);

create unique index matchups_away_slot
  on matchups (league_id, gameweek_id, stage, away_team_id)
  where away_team_id is not null;

-- ------------------------------------------------------- when it starts ----
-- regular_season_end is gone rather than redefined. The regular season now ends
-- when the season does, so a function by that name returning 35 would be a lie
-- waiting to be believed.

drop function if exists regular_season_end(uuid);

create or replace function playoff_start_week(p_league_id uuid)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select max(g.number) - playoff_rounds(l.playoff_teams) + 1
    from leagues l
    join gameweeks g on g.season_id = l.season_id
   where l.id = p_league_id
     and l.playoff_teams > 0
   group by l.playoff_teams;
$$;

comment on function playoff_start_week(uuid) is
  'First gameweek of the bracket. Null when playoffs are off. The league '
  'programme continues through this week and every week after it.';

revoke all on function playoff_start_week(uuid) from public;
grant execute on function playoff_start_week(uuid) to authenticated, service_role;

-- --------------------------------------------------- the full programme ----
-- Back to every gameweek in the season. 0053 stopped early to make room for a
-- bracket that no longer needs any.

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
    select id from gameweeks where season_id = v_season_id order by number
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

-- ------------------------------------------------------------ no longer ----
-- Nothing is trimmed and nobody sits out, so both of these describe a season
-- shape that no longer exists.

drop function if exists trim_schedule_for_playoffs(uuid);
drop function if exists build_consolation(uuid, uuid, integer);

-- ---------------------------------------------------------- the driver ----
-- Seeding no longer waits for the whole regular season, because the whole
-- regular season now finishes after the bracket does. It waits for every league
-- fixture *before* the bracket starts, which is the last moment the table is a
-- complete answer to "who has earned what".

create or replace function advance_playoffs(p_league_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_league   leagues%rowtype;
  v_start    integer;
  v_size     integer;
  v_rounds   integer;
  v_round    integer;
  v_slots    integer;
  v_gameweek uuid;
  v_home     uuid;
  v_away     uuid;
  v_created  integer := 0;
  j          integer;
begin
  select * into v_league from leagues where id = p_league_id;

  if not found or v_league.playoff_teams = 0 or v_league.status <> 'active' then
    return null;
  end if;

  v_rounds := playoff_rounds(v_league.playoff_teams);
  v_start := playoff_start_week(p_league_id);
  v_size := power(2, v_rounds)::integer;

  if v_start is null then
    return null;
  end if;

  -- Every league fixture before the bracket opens must be settled. Fixtures
  -- during the bracket weeks are deliberately not required: they are still
  -- being played, for the title, at the same time.
  if exists (
    select 1
      from matchups m
      join gameweeks g on g.id = m.gameweek_id
     where m.league_id = p_league_id
       and m.stage = 'regular'
       and g.number < v_start
       and m.status <> 'final'
  ) or not exists (
    select 1
      from matchups m
      join gameweeks g on g.id = m.gameweek_id
     where m.league_id = p_league_id and m.stage = 'regular' and g.number < v_start
  ) then
    return null;
  end if;

  -- --- seeds ---------------------------------------------------------------
  -- Frozen from the table as it stands the moment the bracket opens. It will
  -- keep moving afterwards; these will not.
  if not exists (select 1 from playoff_seeds where league_id = p_league_id) then
    insert into playoff_seeds (league_id, team_id, seed)
    select p_league_id, s.team_id,
           row_number() over (
             order by s.wins desc, s.points_for desc, s.team_id
           )
      from league_standings s
     where s.league_id = p_league_id;
  end if;

  select coalesce(max(round), 0) into v_round
    from matchups where league_id = p_league_id and stage = 'playoff';

  if v_round >= v_rounds then
    return null;
  end if;

  if v_round > 0 and exists (
    select 1 from matchups
     where league_id = p_league_id and stage = 'playoff'
       and round = v_round and status <> 'final'
  ) then
    return null;
  end if;

  v_round := v_round + 1;
  v_slots := v_size / power(2, v_round)::integer;

  select id into v_gameweek
    from gameweeks
   where season_id = v_league.season_id and number = v_start + v_round - 1;

  if v_gameweek is null then
    return format('gameweek %s does not exist', v_start + v_round - 1);
  end if;

  for j in 1 .. v_slots loop
    if v_round = 1 then
      select team_id into v_home
        from playoff_seeds where league_id = p_league_id and seed = j;
      select team_id into v_away
        from playoff_seeds
       where league_id = p_league_id
         and seed = v_size + 1 - j
         and seed <= v_league.playoff_teams;
    else
      v_home := playoff_winner((
        select id from matchups
         where league_id = p_league_id and stage = 'playoff'
           and round = v_round - 1 and bracket_slot = 2 * j - 1
      ));
      v_away := playoff_winner((
        select id from matchups
         where league_id = p_league_id and stage = 'playoff'
           and round = v_round - 1 and bracket_slot = 2 * j
      ));
    end if;

    if v_home is null then
      v_home := v_away;
      v_away := null;
    end if;

    if v_home is not null then
      insert into matchups (
        league_id, gameweek_id, home_team_id, away_team_id, stage, round, bracket_slot
      )
      values (p_league_id, v_gameweek, v_home, v_away, 'playoff', v_round, j);
      v_created := v_created + 1;
    end if;
  end loop;

  return format('round %s of %s: %s tie(s)', v_round, v_rounds, v_created);
end;
$$;

comment on function advance_playoffs(uuid) is
  'Idempotent. Freezes seeds from the table as the bracket opens, then adds one '
  'round per gameweek. The league programme runs on unchanged alongside it.';

revoke all on function advance_playoffs(uuid) from public;
grant execute on function advance_playoffs(uuid) to authenticated, service_role;

-- ------------------------------------------------------------- verify ----

do $$
declare
  v_league record;
begin
  for v_league in
    select l.name, l.playoff_teams,
           playoff_start_week(l.id) as starts,
           (select max(g.number) from gameweeks g where g.season_id = l.season_id) as weeks
      from leagues l
     where l.status = 'active'
  loop
    if v_league.playoff_teams = 0 then
      raise notice '% — no playoffs; the league runs all % weeks.', v_league.name, v_league.weeks;
    else
      raise notice
        '% — league programme runs all % weeks; bracket occupies % to %.',
        v_league.name, v_league.weeks, v_league.starts, v_league.weeks;
    end if;
  end loop;
end $$;
