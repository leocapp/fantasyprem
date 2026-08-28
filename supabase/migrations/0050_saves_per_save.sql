-- 0050_saves_per_save.sql
-- Goalkeepers are paid per save, not per third save.
--
-- 'saves_3' was inherited from FPL, where a keeper earns a point for every
-- three stops. The floor() in it means the first two saves of a match are worth
-- nothing and the third is worth a point, which makes a two-save clean sheet
-- and a nil-save clean sheet identical. Per-save at 0.5 pays the same over a
-- season and stops throwing away the remainder.
--
-- Gameweek 1 is not affected. 0045 freezes a gameweek once its points are newer
-- than the statistics behind them, which gameweek 1 is — verified before this
-- was written. score_all will skip it and the results stand.
--
-- Set to 0.5 here so nothing silently drops to zero between this migration and
-- the league settings page. Change it there afterwards.

-- ------------------------------------------------------------- scoring ----
-- 0046's definition, with two changes.
--
-- The saves rate reads 'saves' and multiplies the count directly. And every
-- rate is now coalesced to zero.
--
-- That second one matters more than the first. The rate columns are built from
-- `max(points) filter (where stat_key = ...)` over the keys that exist in
-- scoring_rules, so a key that isn't there produces NULL, and one NULL term
-- turns the entire points sum NULL — every player, every team, silently zeroed.
-- 0034's header warned about exactly this when it removed the bonus rule, and
-- the warning has been sitting one typo away from being needed ever since.
-- Renaming a stat key should not be able to erase a league's season.

create or replace function score_gameweek(p_league_id uuid, p_gameweek_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_scored integer;
  v_carry  boolean;
  v_team   record;
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
      coalesce(max(points) filter (where stat_key = 'minutes_played'), 0)      as r_minutes_played,
      coalesce(max(points) filter (where stat_key = 'minutes_full'), 0)        as r_minutes_full,
      coalesce(max(points) filter (where stat_key = 'goals'), 0)               as r_goals,
      coalesce(max(points) filter (where stat_key = 'assists'), 0)             as r_assists,
      coalesce(max(points) filter (where stat_key = 'clean_sheet'), 0)         as r_clean_sheet,
      coalesce(max(points) filter (where stat_key = 'goals_conceded_2'), 0)    as r_conceded,
      coalesce(max(points) filter (where stat_key = 'saves'), 0)               as r_saves,
      coalesce(max(points) filter (where stat_key = 'penalties_saved'), 0)     as r_pen_saved,
      coalesce(max(points) filter (where stat_key = 'penalties_missed'), 0)    as r_pen_missed,
      coalesce(max(points) filter (where stat_key = 'own_goals'), 0)           as r_own_goals,
      coalesce(max(points) filter (where stat_key = 'yellow_cards'), 0)        as r_yellow,
      coalesce(max(points) filter (where stat_key = 'red_cards'), 0)           as r_red,
      coalesce(max(points) filter (where stat_key = 'shots_on_target'), 0)     as r_shots,
      coalesce(max(points) filter (where stat_key = 'key_passes'), 0)          as r_key_passes,
      coalesce(max(points) filter (where stat_key = 'tackles'), 0)             as r_tackles,
      coalesce(max(points) filter (where stat_key = 'interceptions'), 0)       as r_interceptions,
      coalesce(max(points) filter (where stat_key = 'big_chances_created'), 0) as r_big_chances,
      coalesce(max(points) filter (where stat_key = 'duels_won'), 0)           as r_duels
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
        'saves',            r.r_saves      * t.saves,
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
      + r.r_saves      * t.saves
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

  -- Must come after the scores are written: a bye's opponent is an average of
  -- the other teams' totals, and those totals are read back out of the rows
  -- this function has just inserted.
  perform settle_matchups(p_league_id, p_gameweek_id);

  return v_scored;
end;
$$;

revoke all on function score_gameweek(uuid, uuid) from public;
grant execute on function score_gameweek(uuid, uuid) to authenticated, service_role;

-- ---------------------------------------------------------- projections ----
-- 0043's definition, one line different. rule_points already coalesces to zero,
-- so this was never at risk of the NULL problem above — but a projection that
-- silently prices saves at nothing is its own quiet wrongness.

create or replace function projected_points(
  p_league_id uuid,
  p_player_id uuid,
  p_gameweek_id uuid,
  p_minimum_matches integer default 3
)
returns numeric
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_position player_position;
  v_e        player_gameweek_expectations%rowtype;
  v_total    numeric := 0;
begin
  select position into v_position from players where id = p_player_id;

  select * into v_e
    from player_gameweek_expectations
   where player_id = p_player_id and gameweek_id = p_gameweek_id;

  if not found or v_e.matches_observed < p_minimum_matches then
    return null;
  end if;

  -- Appearance: the 60-minute threshold is worth more, so split the two.
  v_total := v_total
    + v_e.full_game_probability * rule_points(p_league_id, 'minutes_full', v_position)
    + greatest(0, least(1, v_e.minutes / 60.0) - v_e.full_game_probability)
      * rule_points(p_league_id, 'minutes_played', v_position);

  v_total := v_total
    + v_e.goals   * rule_points(p_league_id, 'goals', v_position)
    + v_e.assists * rule_points(p_league_id, 'assists', v_position)
    + v_e.clean_sheet_probability * rule_points(p_league_id, 'clean_sheet', v_position)
    + (v_e.goals_conceded / 2.0) * rule_points(p_league_id, 'goals_conceded_2', v_position)
    + v_e.saves * rule_points(p_league_id, 'saves', v_position)
    + v_e.yellow_cards * rule_points(p_league_id, 'yellow_cards', v_position);

  -- The six from 0028. Priced through rule_points like everything else, so a
  -- league that leaves them at zero sees no change at all.
  v_total := v_total
    + v_e.shots_on_target     * rule_points(p_league_id, 'shots_on_target', v_position)
    + v_e.key_passes          * rule_points(p_league_id, 'key_passes', v_position)
    + v_e.tackles             * rule_points(p_league_id, 'tackles', v_position)
    + v_e.interceptions       * rule_points(p_league_id, 'interceptions', v_position)
    + v_e.big_chances_created * rule_points(p_league_id, 'big_chances_created', v_position)
    + v_e.duels_won           * rule_points(p_league_id, 'duels_won', v_position);

  return round(v_total, 1);
end;
$$;

revoke all on function projected_points(uuid, uuid, uuid, integer) from public;
grant execute on function projected_points(uuid, uuid, uuid, integer)
  to authenticated, service_role;

-- --------------------------------------------------------- draft values ----
-- 0030's definition, one line different. Nothing reads this until next August,
-- which is exactly why it needs changing now — nobody will remember in ten
-- months that keepers are priced at zero saves.

create or replace function recompute_draft_values(p_league_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_season_id uuid;
  v_rows      integer;
begin
  select f.season_id into v_season_id
    from player_match_stats pms
    join fixtures f on f.id = pms.fixture_id
    join seasons s on s.id = f.season_id
   where not s.is_current
   order by s.ends_on desc
   limit 1;

  if v_season_id is null then
    return 0;
  end if;

  with totals as (
    select
      pms.player_id,
      pl.position,
      count(*) filter (where pms.minutes > 0)   as appearances,
      count(*) filter (where pms.minutes >= 60) as full_games,
      sum(pms.goals)                            as goals,
      sum(pms.assists)                          as assists,
      count(*) filter (where pms.clean_sheet)   as clean_sheets,
      sum(pms.goals_conceded)                   as goals_conceded,
      sum(pms.own_goals)                        as own_goals,
      sum(pms.penalties_saved)                  as penalties_saved,
      sum(pms.penalties_missed)                 as penalties_missed,
      sum(pms.saves)                            as saves,
      sum(pms.yellow_cards)                     as yellow_cards,
      sum(pms.red_cards)                        as red_cards,
      coalesce(sum(pms.shots_on_target), 0)     as shots_on_target,
      coalesce(sum(pms.key_passes), 0)          as key_passes,
      coalesce(sum(pms.tackles), 0)             as tackles,
      coalesce(sum(pms.interceptions), 0)       as interceptions,
      coalesce(sum(pms.big_chances_created), 0) as big_chances_created,
      coalesce(sum(pms.duels_won), 0)           as duels_won
    from player_match_stats pms
    join fixtures f on f.id = pms.fixture_id
    join players pl on pl.id = pms.player_id
    where f.season_id = v_season_id
    group by pms.player_id, pl.position
  )
  insert into draft_values (league_id, player_id, season_id, points, appearances, computed_at)
  select
    p_league_id,
    t.player_id,
    v_season_id,
    round(
      (t.appearances - t.full_games) * rule_points(p_league_id, 'minutes_played', t.position)
      + t.full_games          * rule_points(p_league_id, 'minutes_full', t.position)
      + t.goals               * rule_points(p_league_id, 'goals', t.position)
      + t.assists             * rule_points(p_league_id, 'assists', t.position)
      + t.clean_sheets        * rule_points(p_league_id, 'clean_sheet', t.position)
      + floor(t.goals_conceded / 2.0) * rule_points(p_league_id, 'goals_conceded_2', t.position)
      + t.saves               * rule_points(p_league_id, 'saves', t.position)
      + t.penalties_saved     * rule_points(p_league_id, 'penalties_saved', t.position)
      + t.penalties_missed    * rule_points(p_league_id, 'penalties_missed', t.position)
      + t.own_goals           * rule_points(p_league_id, 'own_goals', t.position)
      + t.yellow_cards        * rule_points(p_league_id, 'yellow_cards', t.position)
      + t.red_cards           * rule_points(p_league_id, 'red_cards', t.position)
      + t.shots_on_target     * rule_points(p_league_id, 'shots_on_target', t.position)
      + t.key_passes          * rule_points(p_league_id, 'key_passes', t.position)
      + t.tackles             * rule_points(p_league_id, 'tackles', t.position)
      + t.interceptions       * rule_points(p_league_id, 'interceptions', t.position)
      + t.big_chances_created * rule_points(p_league_id, 'big_chances_created', t.position)
      + t.duels_won           * rule_points(p_league_id, 'duels_won', t.position)
      , 1),
    t.appearances,
    now()
  from totals t
  on conflict (league_id, player_id, season_id)
  do update set points = excluded.points,
                appearances = excluded.appearances,
                computed_at = excluded.computed_at;

  get diagnostics v_rows = row_count;

  return v_rows;
end;
$$;

revoke all on function recompute_draft_values(uuid) from public;
grant execute on function recompute_draft_values(uuid) to authenticated, service_role;

-- ------------------------------------------------------------- the rules ----
-- Renamed rather than deleted and re-inserted, so any per-position overrides a
-- commissioner set survive. 0.5 as a starting value: over a season it pays a
-- keeper roughly what three-saves-per-point did, without discarding the
-- remainder every match.

update scoring_rules
   set stat_key = 'saves', points = 0.5
 where stat_key = 'saves_3';

update default_scoring_rules
   set stat_key = 'saves', points = 0.5
 where stat_key = 'saves_3';

-- ---------------------------------------------------------------- verify ----

do $$
declare
  v_old integer;
  v_new integer;
begin
  select count(*) into v_old from scoring_rules where stat_key = 'saves_3';
  select count(*) into v_new from scoring_rules where stat_key = 'saves';

  if v_old > 0 then
    raise exception 'Aborting: % saves_3 rule(s) survived the rename.', v_old;
  end if;

  if v_new = 0 then
    raise warning 'No saves rule exists in any league — keepers now score nothing for saves.';
  end if;
end $$;
