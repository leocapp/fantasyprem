-- 0054_playoff_bracket.sql
-- The bracket itself: seeds, rounds, advancement, and something for everyone
-- who isn't in it.
--
-- Everything runs off matchups. A bracket game is an ordinary fixture that
-- knows its round and slot, so scoring, the matchup page, the live badge and
-- the colour bands all work without being told playoffs exist.
--
-- Slot numbering is the standard one. Round 1 slot i pairs seed i against seed
-- (size + 1 - i), where size is playoff_teams rounded up to a power of two.
-- Seeds beyond playoff_teams don't exist, which is how byes fall out: with
-- seven teams in a bracket of eight, slot 1 is "seed 1 against nobody". Round
-- r slot j is fed by round r-1 slots 2j-1 and 2j.

-- ---------------------------------------------------------------- seeds ----
-- Frozen, never recomputed. If the bracket read the standings live, a deferred
-- fixture settling in week 36 could reseed a tournament already under way —
-- and this league has already had a gameweek stay provisional for days.
--
-- Every team is seeded, not only the qualifiers. The teams that miss out need
-- an order too, for the consolation pairings below.

create table if not exists playoff_seeds (
  league_id  uuid not null references leagues (id) on delete cascade,
  team_id    uuid not null references fantasy_teams (id) on delete cascade,
  seed       integer not null,
  frozen_at  timestamptz not null default now(),
  primary key (league_id, team_id),
  unique (league_id, seed)
);

alter table playoff_seeds enable row level security;

create policy playoff_seeds_read
  on playoff_seeds for select to authenticated
  using (is_league_member(league_id) or is_league_commissioner(league_id));

grant select on playoff_seeds to authenticated;

-- --------------------------------------------------------- winner of one ----
-- A bye has no opponent and advances. A tie goes to the better seed, which
-- rewards the regular season one last time and needs no extra data — the
-- alternatives (bench points, best single return) are more fun and more to
-- explain, and can replace this one function later without touching anything
-- else.

create or replace function playoff_winner(p_matchup_id uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  m          matchups%rowtype;
  v_home_seed integer;
  v_away_seed integer;
begin
  select * into m from matchups where id = p_matchup_id;

  if not found or m.status <> 'final' then
    return null;
  end if;

  if m.away_team_id is null then
    return m.home_team_id;
  end if;

  if m.home_points > m.away_points then return m.home_team_id; end if;
  if m.away_points > m.home_points then return m.away_team_id; end if;

  select seed into v_home_seed
    from playoff_seeds where league_id = m.league_id and team_id = m.home_team_id;
  select seed into v_away_seed
    from playoff_seeds where league_id = m.league_id and team_id = m.away_team_id;

  -- Lower seed number is the better team.
  return case
           when coalesce(v_home_seed, 999) <= coalesce(v_away_seed, 999)
           then m.home_team_id
           else m.away_team_id
         end;
end;
$$;

revoke all on function playoff_winner(uuid) from public;
grant execute on function playoff_winner(uuid) to authenticated, service_role;

-- ------------------------------------------------- byes are not the field ----
-- settle_matchups scores a null opponent as the league average, which is right
-- for a regular-season bye and wrong for a bracket one: a top seed resting
-- should advance, not play a fixture it could lose. Same function as 0046 with
-- the average restricted to the stages where it means something.

create or replace function settle_matchups(p_league_id uuid, p_gameweek_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_complete boolean;
  v_settled  integer;
begin
  select status = 'complete' into v_complete from gameweeks where id = p_gameweek_id;

  update matchups m
     set home_points = coalesce(team_gameweek_points(m.home_team_id, p_gameweek_id), 0),
         away_points = case
           when m.away_team_id is not null
             then coalesce(team_gameweek_points(m.away_team_id, p_gameweek_id), 0)
           -- A playoff bye is an advancement, not a fixture. Nil-all, and
           -- playoff_winner sends the home team through.
           when m.stage = 'playoff' then 0
           else coalesce((
             select avg(coalesce(team_gameweek_points(ft.id, p_gameweek_id), 0))
               from fantasy_teams ft
              where ft.league_id = p_league_id
                and ft.id <> m.home_team_id
           ), 0)
         end,
         status = case when v_complete then 'final'::matchup_status
                       else 'live'::matchup_status end
   where m.league_id = p_league_id
     and m.gameweek_id = p_gameweek_id;

  get diagnostics v_settled = row_count;
  return v_settled;
end;
$$;

revoke all on function settle_matchups(uuid, uuid) from public;
grant execute on function settle_matchups(uuid, uuid) to service_role;

-- --------------------------------------------------------- consolation ----
-- Everyone still alive in the bracket has a game. Everyone else is paired off
-- by seed, and if that leaves somebody over they play the league average —
-- the same mechanism as a regular-season bye, which is what makes an odd
-- number of leftovers a non-problem rather than a blocker.
--
-- With seven teams there is always an odd number left over. That isn't a flaw
-- in the arithmetic; it's why the field exists.

create or replace function build_consolation(
  p_league_id   uuid,
  p_gameweek_id uuid,
  p_round       integer
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_idle    uuid[];
  v_count   integer;
  v_created integer := 0;
  i         integer;
begin
  if not (select consolation from leagues where id = p_league_id) then
    return 0;
  end if;

  select array_agg(ft.id order by coalesce(ps.seed, 999), ft.name)
    into v_idle
    from fantasy_teams ft
    left join playoff_seeds ps on ps.league_id = p_league_id and ps.team_id = ft.id
   where ft.league_id = p_league_id
     and not exists (
       select 1 from matchups m
        where m.league_id = p_league_id
          and m.gameweek_id = p_gameweek_id
          and m.stage = 'playoff'
          and (m.home_team_id = ft.id or m.away_team_id = ft.id)
     );

  v_count := coalesce(array_length(v_idle, 1), 0);

  -- Adjacent seeds rather than best against worst: two teams who finished
  -- next to each other is a closer game than first against last.
  i := 1;
  while i <= v_count loop
    if i + 1 <= v_count then
      insert into matchups (
        league_id, gameweek_id, home_team_id, away_team_id, stage, round, bracket_slot
      )
      values (
        p_league_id, p_gameweek_id, v_idle[i], v_idle[i + 1], 'consolation', p_round, (i + 1) / 2
      );
      i := i + 2;
    else
      insert into matchups (
        league_id, gameweek_id, home_team_id, away_team_id, stage, round, bracket_slot
      )
      values (p_league_id, p_gameweek_id, v_idle[i], null, 'consolation', p_round, (i + 1) / 2);
      i := i + 1;
    end if;

    v_created := v_created + 1;
  end loop;

  return v_created;
end;
$$;

revoke all on function build_consolation(uuid, uuid, integer) from public;
grant execute on function build_consolation(uuid, uuid, integer) to service_role;

-- ------------------------------------------------------------- the driver ----
-- One idempotent function. Freezes seeds if they aren't, opens round one if it
-- hasn't opened, advances if a round has finished. Safe to call every run,
-- which is the point: the cron doesn't have to know what stage anything is at.

create or replace function advance_playoffs(p_league_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_league   leagues%rowtype;
  v_last     integer;
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
  v_last := regular_season_end(p_league_id);
  v_size := power(2, v_rounds)::integer;

  -- Nothing happens until the regular season is genuinely over. An unplayed or
  -- provisional fixture means the seeds aren't known yet, and seeding on a
  -- table that can still move is how a bracket ends up wrong.
  if exists (
    select 1 from matchups
     where league_id = p_league_id and stage = 'regular' and status <> 'final'
  ) or not exists (
    select 1 from matchups where league_id = p_league_id and stage = 'regular'
  ) then
    return null;
  end if;

  -- --- seeds ---------------------------------------------------------------
  if not exists (select 1 from playoff_seeds where league_id = p_league_id) then
    insert into playoff_seeds (league_id, team_id, seed)
    select p_league_id, s.team_id,
           row_number() over (
             order by s.wins desc, s.points_for desc, s.team_id
           )
      from league_standings s
     where s.league_id = p_league_id;
  end if;

  -- --- which round are we on? ---------------------------------------------
  select coalesce(max(round), 0) into v_round
    from matchups where league_id = p_league_id and stage = 'playoff';

  if v_round >= v_rounds then
    return null;  -- tournament complete
  end if;

  -- A round in progress blocks the next one. Deferred fixtures make this a real
  -- case: the round's gameweek can stay provisional for days.
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
   where season_id = v_league.season_id and number = v_last + v_round;

  if v_gameweek is null then
    return format('gameweek %s does not exist', v_last + v_round);
  end if;

  -- --- build the round -----------------------------------------------------
  for j in 1 .. v_slots loop
    if v_round = 1 then
      -- Seeds beyond playoff_teams simply aren't there, and the pairing comes
      -- back one-sided. That is a bye, not a missing row.
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

  perform build_consolation(p_league_id, v_gameweek, v_round);

  return format('round %s of %s: %s tie(s)', v_round, v_rounds, v_created);
end;
$$;

comment on function advance_playoffs(uuid) is
  'Idempotent. Freezes seeds, opens round one, or advances a finished round. '
  'Does nothing until every regular-season fixture is final.';

revoke all on function advance_playoffs(uuid) from public;
grant execute on function advance_playoffs(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------- all of them ----

create or replace function advance_playoffs_all()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_league record;
  v_result text;
  v_moved  integer := 0;
begin
  for v_league in
    select id, name from leagues where status = 'active' and playoff_teams > 0
  loop
    v_result := advance_playoffs(v_league.id);

    if v_result is not null then
      raise notice '%: %', v_league.name, v_result;
      v_moved := v_moved + 1;
    end if;
  end loop;

  return v_moved;
end;
$$;

revoke all on function advance_playoffs_all() from public;
grant execute on function advance_playoffs_all() to service_role;
