-- 0020_carry_forward_lineups.sql
-- Reuse last week's lineup when a manager doesn't set one.
--
-- Materialised rather than implied: the previous lineup is copied into a real
-- lineup row for the gameweek. That way the matchup page shows the XI that
-- actually scored instead of "no lineup set", and the result is auditable
-- afterwards.
--
-- Copying happens inside score_gameweek, which only runs after matches, so a
-- manager still has the whole week to set their own.

alter table leagues
  add column if not exists carry_forward_lineups boolean not null default true;

alter table lineups
  add column if not exists carried_forward boolean not null default false;

-- --------------------------------------------------------- carry forward ----

create or replace function carry_forward_lineup(p_team_id uuid, p_gameweek_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_number    integer;
  v_season_id uuid;
  v_previous  uuid;
  v_new       uuid;
  v_starters  integer;
begin
  if exists (
    select 1 from lineups
     where fantasy_team_id = p_team_id and gameweek_id = p_gameweek_id
  ) then
    return false;
  end if;

  select number, season_id into v_number, v_season_id
    from gameweeks where id = p_gameweek_id;

  -- Most recent earlier lineup in the same season.
  select l.id into v_previous
    from lineups l
    join gameweeks g on g.id = l.gameweek_id
   where l.fantasy_team_id = p_team_id
     and g.season_id = v_season_id
     and g.number < v_number
   order by g.number desc
   limit 1;

  if v_previous is null then
    return false;
  end if;

  insert into lineups (fantasy_team_id, gameweek_id, formation, carried_forward)
  select p_team_id, p_gameweek_id, formation, true
    from lineups where id = v_previous
  returning id into v_new;

  -- Only players still on the roster carry over. Someone traded away since
  -- last week can't score for a team that no longer owns them.
  insert into lineup_players (
    lineup_id, player_id, role, bench_order, is_captain, is_vice_captain
  )
  select v_new, lp.player_id, lp.role, lp.bench_order, lp.is_captain, lp.is_vice_captain
    from lineup_players lp
   where lp.lineup_id = v_previous
     and exists (
       select 1 from roster_entries re
        where re.fantasy_team_id = p_team_id
          and re.player_id = lp.player_id
          and re.dropped_at is null
     );

  select count(*) into v_starters
    from lineup_players where lineup_id = v_new and role = 'starter';

  -- Nothing survived the week — a copy with no players is just noise.
  if v_starters = 0 then
    delete from lineups where id = v_new;
    return false;
  end if;

  return true;
end;
$$;

-- ------------------------------------------------- score gameweek (upd) ----
-- Same as 0010, with a carry-forward pass before matchups are settled.

create or replace function score_gameweek(p_league_id uuid, p_gameweek_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_scored   integer;
  v_complete boolean;
  v_carry    boolean;
  v_team     record;
begin
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

  -- Fill in missing lineups from last week before settling anything.
  select carry_forward_lineups into v_carry from leagues where id = p_league_id;

  if coalesce(v_carry, false) then
    for v_team in select id from fantasy_teams where league_id = p_league_id loop
      perform carry_forward_lineup(v_team.id, p_gameweek_id);
    end loop;
  end if;

  select status = 'complete' into v_complete from gameweeks where id = p_gameweek_id;

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

revoke all on function carry_forward_lineup(uuid, uuid) from public;
revoke all on function score_gameweek(uuid, uuid) from public;

grant execute on function carry_forward_lineup(uuid, uuid) to authenticated, service_role;
grant execute on function score_gameweek(uuid, uuid) to authenticated, service_role;
