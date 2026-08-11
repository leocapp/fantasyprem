-- 0034_remove_bonus_points.sql
-- Bonus points were an FPL invention and Sportmonks has no equivalent.
--
-- The ingestion has been writing a hardcoded zero into player_match_stats.bonus
-- since the switch (see the comment in sportmonks.py), so the rule has been
-- worth nothing to anybody for some time. It still appeared in league settings
-- and promised +1 in the player scoring key, which is worse than not offering
-- it at all.
--
-- The rule can't simply be deleted. score_gameweek builds its rate columns with
--   max(points) filter (where stat_key = 'bonus') as r_bonus
-- over the keys present in scoring_rules, so with the rule gone r_bonus is NULL,
-- and `+ r.r_bonus * t.bonus` would turn the whole points sum NULL — every score
-- in every league, silently. So the function is replaced first, then the rules
-- are deleted.
--
-- player_match_stats.bonus is deliberately kept. It's always zero now, but
-- app.ingest.fpl still writes it and that module is the revert path.

-- ------------------------------------------------ 1. scoring without bonus ----
-- Byte-for-byte the definition from 0028 with the four bonus lines removed:
-- the r_bonus rate, the sum(pms.bonus) total, its breakdown entry, and its term
-- in the points sum.

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
      max(points) filter (where stat_key = 'minutes_played')      as r_minutes_played,
      max(points) filter (where stat_key = 'minutes_full')        as r_minutes_full,
      max(points) filter (where stat_key = 'goals')               as r_goals,
      max(points) filter (where stat_key = 'assists')             as r_assists,
      max(points) filter (where stat_key = 'clean_sheet')         as r_clean_sheet,
      max(points) filter (where stat_key = 'goals_conceded_2')    as r_conceded,
      max(points) filter (where stat_key = 'saves_3')             as r_saves,
      max(points) filter (where stat_key = 'penalties_saved')     as r_pen_saved,
      max(points) filter (where stat_key = 'penalties_missed')    as r_pen_missed,
      max(points) filter (where stat_key = 'own_goals')           as r_own_goals,
      max(points) filter (where stat_key = 'yellow_cards')        as r_yellow,
      max(points) filter (where stat_key = 'red_cards')           as r_red,
      max(points) filter (where stat_key = 'shots_on_target')     as r_shots,
      max(points) filter (where stat_key = 'key_passes')          as r_key_passes,
      max(points) filter (where stat_key = 'tackles')             as r_tackles,
      max(points) filter (where stat_key = 'interceptions')       as r_interceptions,
      max(points) filter (where stat_key = 'big_chances_created') as r_big_chances,
      max(points) filter (where stat_key = 'duels_won')           as r_duels
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
      coalesce(sum(pms.shots_on_target), 0)     as shots_on_target,
      coalesce(sum(pms.key_passes), 0)          as key_passes,
      coalesce(sum(pms.tackles), 0)             as tackles,
      coalesce(sum(pms.interceptions), 0)       as interceptions,
      coalesce(sum(pms.big_chances_created), 0) as big_chances_created,
      coalesce(sum(pms.duels_won), 0)           as duels_won
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
        'shots_on_target',     r.r_shots        * t.shots_on_target,
        'key_passes',          r.r_key_passes   * t.key_passes,
        'tackles',             r.r_tackles      * t.tackles,
        'interceptions',       r.r_interceptions * t.interceptions,
        'big_chances_created', r.r_big_chances  * t.big_chances_created,
        'duels_won',           r.r_duels        * t.duels_won,
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
      + r.r_shots         * t.shots_on_target
      + r.r_key_passes    * t.key_passes
      + r.r_tackles       * t.tackles
      + r.r_interceptions * t.interceptions
      + r.r_big_chances   * t.big_chances_created
      + r.r_duels         * t.duels_won as points
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

revoke all on function score_gameweek(uuid, uuid) from public;
grant execute on function score_gameweek(uuid, uuid) to authenticated, service_role;

-- --------------------------------------------------- 2. season totals view ----
-- Dropped and recreated rather than replaced: `create or replace view` can only
-- add columns to the end of a view, never remove one, and this loses `bonus`.
--
-- No cascade. Nothing else in the schema selects from this view — only the
-- player page does — so if a dependency has appeared since, this should fail
-- rather than quietly take it with us.

drop view if exists player_season_stats;

create view player_season_stats as
select
  pms.player_id,
  f.season_id,
  count(*) filter (where pms.minutes > 0)   as appearances,
  count(*) filter (where pms.minutes >= 60) as full_games,
  coalesce(sum(pms.minutes), 0)             as minutes,
  coalesce(sum(pms.goals), 0)               as goals,
  coalesce(sum(pms.assists), 0)             as assists,
  count(*) filter (where pms.clean_sheet)   as clean_sheets,
  coalesce(sum(pms.goals_conceded), 0)      as goals_conceded,
  coalesce(sum(pms.saves), 0)               as saves,
  coalesce(sum(pms.yellow_cards), 0)        as yellow_cards,
  coalesce(sum(pms.red_cards), 0)           as red_cards
from player_match_stats pms
join fixtures f on f.id = pms.fixture_id
group by pms.player_id, f.season_id;

alter view player_season_stats set (security_invoker = on);

-- Dropping a view takes its grants with it. Default privileges probably cover
-- this, but restating it costs nothing and the alternative is a player page
-- that 401s in production.
grant select on player_season_stats to authenticated;

-- ----------------------------------------------------- 3. drop the rules ----

delete from scoring_rules         where stat_key = 'bonus';
delete from default_scoring_rules where stat_key = 'bonus';

-- Historic breakdowns may carry a 'bonus' key worth 0. It renders as nothing
-- (the UI skips zero entries) and rewriting stored JSON to remove a zero would
-- be churn for its own sake, so they're left alone.

-- ------------------------------------------------------------ 4. verify ----

do $$
declare
  v_rules integer;
begin
  select count(*) into v_rules
    from scoring_rules where stat_key = 'bonus';

  if v_rules > 0 then
    raise exception 'Aborting: % bonus rule(s) survived the delete.', v_rules;
  end if;
end $$;
