-- 0010_scoring.sql
-- Turning real match performances into league standings.
--
-- Three pieces:
--   generate_schedule  builds the head-to-head fixture list for a league
--   score_gameweek     applies a league's scoring rules to raw stats
--   score_all          runs score_gameweek for every league in a season

-- ------------------------------------------------------ generate schedule ----
-- Circle-method round robin: fix the first team, rotate the rest each week.
-- With an odd number of teams one gets a bye (away_team_id is null).
--
-- No commissioner check: it is guarded on state instead, so make_pick can call
-- it automatically when the final pick lands. It refuses to touch a schedule
-- that already has settled results.

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
        insert into matchups (league_id, gameweek_id, home_team_id, away_team_id)
        values (p_league_id, v_gameweek.id, v_home, v_away);
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

-- ---------------------------------------------------------- score gameweek ----

create or replace function score_gameweek(p_league_id uuid, p_gameweek_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_scored   integer;
  v_complete boolean;
begin
  -- Per-position rule table: a position-specific rule wins, otherwise the
  -- rule that applies to everyone, otherwise zero.
  with keys as (
    select distinct stat_key from scoring_rules where league_id = p_league_id
  ),
  positions as (
    select unnest(enum_range(null::player_position)) as position
  ),
  resolved as (
    select
      p.position,
      k.stat_key,
      coalesce(
        (select points from scoring_rules s
          where s.league_id = p_league_id and s.stat_key = k.stat_key
            and s.applies_to = p.position),
        (select points from scoring_rules s
          where s.league_id = p_league_id and s.stat_key = k.stat_key
            and s.applies_to is null),
        0
      ) as points
    from positions p
    cross join keys k
  ),
  rules as (
    select
      position,
      max(points) filter (where stat_key = 'minutes_played')   as r_minutes_played,
      max(points) filter (where stat_key = 'minutes_full')     as r_minutes_full,
      max(points) filter (where stat_key = 'goals')            as r_goals,
      max(points) filter (where stat_key = 'assists')          as r_assists,
      max(points) filter (where stat_key = 'clean_sheet')      as r_clean_sheet,
      max(points) filter (where stat_key = 'goals_conceded_2') as r_conceded,
      max(points) filter (where stat_key = 'saves_3')          as r_saves,
      max(points) filter (where stat_key = 'penalties_saved')  as r_pen_saved,
      max(points) filter (where stat_key = 'penalties_missed') as r_pen_missed,
      max(points) filter (where stat_key = 'own_goals')        as r_own_goals,
      max(points) filter (where stat_key = 'yellow_cards')     as r_yellow,
      max(points) filter (where stat_key = 'red_cards')        as r_red,
      max(points) filter (where stat_key = 'bonus')            as r_bonus
    from resolved
    group by position
  ),
  -- A player can have two fixtures in one gameweek; totals are what matter.
  totals as (
    select
      pms.player_id,
      pl.position,
      sum(pms.minutes)           as minutes,
      sum(pms.goals)             as goals,
      sum(pms.assists)           as assists,
      count(*) filter (where pms.clean_sheet) as clean_sheets,
      sum(pms.goals_conceded)    as goals_conceded,
      sum(pms.own_goals)         as own_goals,
      sum(pms.penalties_saved)   as penalties_saved,
      sum(pms.penalties_missed)  as penalties_missed,
      sum(pms.saves)             as saves,
      sum(pms.yellow_cards)      as yellow_cards,
      sum(pms.red_cards)         as red_cards,
      sum(pms.bonus)             as bonus
    from player_match_stats pms
    join fixtures f on f.id = pms.fixture_id
    join players pl on pl.id = pms.player_id
    where f.gameweek_id = p_gameweek_id
    group by pms.player_id, pl.position
  ),
  computed as (
    select
      t.player_id,
      jsonb_strip_nulls(jsonb_build_object(
        'appearance', case when t.minutes >= 60 then r.r_minutes_full
                           when t.minutes > 0  then r.r_minutes_played else 0 end,
        'goals',            r.r_goals      * t.goals,
        'assists',          r.r_assists    * t.assists,
        'clean_sheet',      r.r_clean_sheet * t.clean_sheets,
        'goals_conceded',   r.r_conceded   * floor(t.goals_conceded / 2.0),
        'saves',            r.r_saves      * floor(t.saves / 3.0),
        'penalties_saved',  r.r_pen_saved  * t.penalties_saved,
        'penalties_missed', r.r_pen_missed * t.penalties_missed,
        'own_goals',        r.r_own_goals  * t.own_goals,
        'yellow_cards',     r.r_yellow     * t.yellow_cards,
        'red_cards',        r.r_red        * t.red_cards,
        'bonus',            r.r_bonus      * t.bonus,
        'minutes',          t.minutes
      )) as breakdown,
      (case when t.minutes >= 60 then r.r_minutes_full
            when t.minutes > 0  then r.r_minutes_played else 0 end)
      + r.r_goals      * t.goals
      + r.r_assists    * t.assists
      + r.r_clean_sheet * t.clean_sheets
      + r.r_conceded   * floor(t.goals_conceded / 2.0)
      + r.r_saves      * floor(t.saves / 3.0)
      + r.r_pen_saved  * t.penalties_saved
      + r.r_pen_missed * t.penalties_missed
      + r.r_own_goals  * t.own_goals
      + r.r_yellow     * t.yellow_cards
      + r.r_red        * t.red_cards
      + r.r_bonus      * t.bonus as points
    from totals t
    join rules r on r.position = t.position
  )
  insert into player_gameweek_scores (league_id, player_id, gameweek_id, points, breakdown, computed_at)
  select p_league_id, c.player_id, p_gameweek_id, c.points, c.breakdown, now()
  from computed c
  on conflict (league_id, player_id, gameweek_id)
  do update set points = excluded.points,
                breakdown = excluded.breakdown,
                computed_at = excluded.computed_at;

  get diagnostics v_scored = row_count;

  select status = 'complete' into v_complete from gameweeks where id = p_gameweek_id;

  -- Settle both sides of every matchup in this gameweek.
  update matchups m
     set home_points = coalesce(team_gameweek_points(m.home_team_id, p_gameweek_id), 0),
         away_points = case when m.away_team_id is null then 0
                            else coalesce(team_gameweek_points(m.away_team_id, p_gameweek_id), 0) end,
         status = case when v_complete then 'final'::matchup_status else 'live'::matchup_status end
   where m.league_id = p_league_id
     and m.gameweek_id = p_gameweek_id;

  return v_scored;
end;
$$;

-- ---------------------------------------------------- team gameweek points ----
-- Starters only. The captain scores double; if the captain did not play, the
-- vice-captain takes the armband instead.

create or replace function team_gameweek_points(p_team_id uuid, p_gameweek_id uuid)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  v_league_id  uuid;
  v_lineup_id  uuid;
  v_base       numeric;
  v_captain    uuid;
  v_vice       uuid;
  v_cap_played boolean;
  v_bonus      numeric := 0;
begin
  select league_id into v_league_id from fantasy_teams where id = p_team_id;

  select id into v_lineup_id
    from lineups
   where fantasy_team_id = p_team_id and gameweek_id = p_gameweek_id;

  if v_lineup_id is null then
    return 0;
  end if;

  select
    coalesce(sum(s.points), 0),
    max(lp.player_id) filter (where lp.is_captain),
    max(lp.player_id) filter (where lp.is_vice_captain)
  into v_base, v_captain, v_vice
  from lineup_players lp
  left join player_gameweek_scores s
    on s.player_id = lp.player_id
   and s.gameweek_id = p_gameweek_id
   and s.league_id = v_league_id
  where lp.lineup_id = v_lineup_id
    and lp.role = 'starter';

  select coalesce((breakdown ->> 'minutes')::numeric, 0) > 0
    into v_cap_played
    from player_gameweek_scores
   where league_id = v_league_id and player_id = v_captain and gameweek_id = p_gameweek_id;

  -- Doubling = adding their score once more.
  select coalesce(points, 0) into v_bonus
    from player_gameweek_scores
   where league_id = v_league_id
     and gameweek_id = p_gameweek_id
     and player_id = case when coalesce(v_cap_played, false) then v_captain else v_vice end;

  return v_base + coalesce(v_bonus, 0);
end;
$$;

-- --------------------------------------------------------------- score all ----

create or replace function score_all(p_gameweek_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_league  record;
  v_leagues integer := 0;
begin
  for v_league in
    select l.id
      from leagues l
      join gameweeks g on g.season_id = l.season_id
     where g.id = p_gameweek_id
       and l.status in ('active', 'complete')
  loop
    perform score_gameweek(v_league.id, p_gameweek_id);
    v_leagues := v_leagues + 1;
  end loop;

  return v_leagues;
end;
$$;

revoke all on function score_gameweek(uuid, uuid) from public;
revoke all on function team_gameweek_points(uuid, uuid) from public;
revoke all on function score_all(uuid) from public;

grant execute on function score_gameweek(uuid, uuid) to authenticated, service_role;
grant execute on function team_gameweek_points(uuid, uuid) to authenticated, service_role;
grant execute on function score_all(uuid) to service_role;

-- ------------------------------------------- build the schedule on completion ----
-- Same make_pick as 0009, with one line added at the end.

create or replace function make_pick(p_league_id uuid, p_player_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_team_id  uuid;
  v_pick     draft_picks%rowtype;
  v_league   leagues%rowtype;
  v_position player_position;
  v_limit    integer;
  v_held     integer;
begin
  select * into v_league from leagues where id = p_league_id;

  if not found then
    raise exception 'League not found.';
  end if;

  if v_league.status <> 'drafting' then
    raise exception 'This league is not drafting.';
  end if;

  select id into v_team_id
    from fantasy_teams
   where league_id = p_league_id and owner_id = auth.uid();

  if v_team_id is null then
    raise exception 'You do not have a team in this league.';
  end if;

  select * into v_pick
    from draft_picks
   where league_id = p_league_id and player_id is null
   order by overall_pick
   limit 1
   for update;

  if not found then
    raise exception 'The draft is already complete.';
  end if;

  if v_pick.fantasy_team_id <> v_team_id then
    raise exception 'It is not your turn to pick.';
  end if;

  select position into v_position from players where id = p_player_id and is_active;

  if v_position is null then
    raise exception 'That player is not available.';
  end if;

  if exists (
    select 1 from roster_entries
     where league_id = p_league_id and player_id = p_player_id and dropped_at is null
  ) then
    raise exception 'That player has already been drafted.';
  end if;

  v_limit := case v_position
               when 'GK'  then v_league.slots_gk
               when 'DEF' then v_league.slots_def
               when 'MID' then v_league.slots_mid
               when 'FWD' then v_league.slots_fwd
             end;

  select count(*) into v_held
    from roster_entries re
    join players p on p.id = re.player_id
   where re.fantasy_team_id = v_team_id
     and re.dropped_at is null
     and p.position = v_position;

  if v_held >= v_limit then
    raise exception 'Your squad already has % of % % — pick a different position.',
      v_held, v_limit, v_position;
  end if;

  update draft_picks
     set player_id = p_player_id, picked_at = now()
   where id = v_pick.id;

  insert into roster_entries (league_id, fantasy_team_id, player_id, acquired_via)
  values (p_league_id, v_team_id, p_player_id, 'draft');

  insert into transactions (league_id, fantasy_team_id, type, player_in_id, created_by)
  values (p_league_id, v_team_id, 'draft', p_player_id, auth.uid());

  if not exists (
    select 1 from draft_picks where league_id = p_league_id and player_id is null
  ) then
    update leagues set status = 'active' where id = p_league_id;
    perform generate_schedule(p_league_id);
  end if;

  return v_pick.overall_pick;
end;
$$;

revoke all on function make_pick(uuid, uuid) from public;
grant execute on function make_pick(uuid, uuid) to authenticated;
