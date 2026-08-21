-- 0043_project_extended_stats.sql
-- Project the stats added in 0028, and score them in the projection.
--
-- projected_points was written in 0024. 0028 then added shots on target, key
-- passes, tackles, interceptions, big chances created and duels won — scored
-- by score_gameweek and by recompute_draft_values, but never added here. So a
-- league that prices them was shown projections built from a subset of its own
-- rules: in mine those six are roughly 35-45% of a player's actual points, and
-- the projection was correspondingly low.
--
-- Two halves, because the function couldn't have scored them anyway:
-- player_gameweek_expectations had nowhere to put an expected tackle. The
-- ingestion now estimates a per-90 rate for each, the same way it does for
-- goals and assists.

alter table player_gameweek_expectations
  add column if not exists shots_on_target     numeric(6, 2) not null default 0,
  add column if not exists key_passes          numeric(6, 2) not null default 0,
  add column if not exists tackles             numeric(6, 2) not null default 0,
  add column if not exists interceptions       numeric(6, 2) not null default 0,
  add column if not exists big_chances_created numeric(6, 3) not null default 0,
  add column if not exists duels_won           numeric(6, 2) not null default 0;

comment on column player_gameweek_expectations.duels_won is
  'Expected volume for the gameweek, scaled by expected minutes. Not adjusted '
  'for opponent strength: a defender wins duels at much the same rate whoever '
  'he plays, unlike goals.';

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
    + (v_e.saves / 3.0) * rule_points(p_league_id, 'saves_3', v_position)
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
