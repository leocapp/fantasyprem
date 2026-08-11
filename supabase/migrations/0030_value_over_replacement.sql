-- 0030_value_over_replacement.sql
-- Rank draft value by surplus over a freely available player, not raw points.
--
-- Raw points make a bad draft board. Every team starts one goalkeeper, and the
-- tenth-best keeper scores nearly as much as the best — so taking a keeper
-- early costs you almost nothing in points foregone at that position, while
-- costing you a lot at forward, where the drop-off is steep.
--
-- Replacement level is the score of the best player at a position who will
-- still be available after everyone has filled their starting requirement.
-- With six teams starting one keeper, that's roughly the seventh-best keeper.
-- Subtracting it makes positions comparable.
--
-- Raw points are kept alongside: people want to see the actual number, and
-- hiding it would make the ranking feel arbitrary.

alter table draft_values
  add column if not exists value_over_replacement numeric(7, 1);

create index if not exists draft_values_vor
  on draft_values (league_id, value_over_replacement desc);

create or replace function recompute_replacement_levels(p_league_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_league   leagues%rowtype;
  v_teams    integer;
  v_position player_position;
  v_starters integer;
  v_baseline numeric;
begin
  select * into v_league from leagues where id = p_league_id;
  if not found then
    return;
  end if;

  select count(*) into v_teams from fantasy_teams where league_id = p_league_id;
  if v_teams = 0 then
    v_teams := v_league.max_teams;
  end if;

  foreach v_position in array array['GK', 'DEF', 'MID', 'FWD']::player_position[]
  loop
    -- How many of this position the league starts in a typical XI. Formations
    -- vary, so this uses a middle-of-the-road shape rather than the minimum:
    -- one keeper, four defenders, four midfielders, two forwards.
    v_starters := case v_position
                    when 'GK' then 1
                    when 'DEF' then 4
                    when 'MID' then 4
                    else 2
                  end;

    -- The player just past the point where demand is satisfied.
    select points into v_baseline
      from draft_values d
      join players p on p.id = d.player_id
     where d.league_id = p_league_id
       and p.position = v_position
     order by d.points desc
     offset (v_teams * v_starters)
     limit 1;

    -- Small league, or not enough players ranked: fall back to the worst
    -- ranked player at that position rather than leaving it null.
    if v_baseline is null then
      select min(points) into v_baseline
        from draft_values d
        join players p on p.id = d.player_id
       where d.league_id = p_league_id and p.position = v_position;
    end if;

    update draft_values d
       set value_over_replacement = round(d.points - coalesce(v_baseline, 0), 1)
      from players p
     where p.id = d.player_id
       and d.league_id = p_league_id
       and p.position = v_position;
  end loop;
end;
$$;

-- Fold it into the existing recompute so callers don't have to know about it.
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
      + floor(t.saves / 3.0)  * rule_points(p_league_id, 'saves_3', t.position)
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

  perform recompute_replacement_levels(p_league_id);

  return v_rows;
end;
$$;

revoke all on function recompute_replacement_levels(uuid) from public;
grant execute on function recompute_replacement_levels(uuid) to authenticated, service_role;
