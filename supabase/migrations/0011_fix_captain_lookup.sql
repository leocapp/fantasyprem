-- 0011_fix_captain_lookup.sql
-- max() has no uuid variant, so picking the captain out of the aggregate
-- failed with "function max(uuid) does not exist". array_agg(...)[1] works,
-- and the partial unique indexes on lineup_players guarantee there is at most
-- one captain and one vice per lineup.

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
    (array_agg(lp.player_id) filter (where lp.is_captain))[1],
    (array_agg(lp.player_id) filter (where lp.is_vice_captain))[1]
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

  -- Doubling = adding their score once more. Vice takes over if the captain
  -- did not play.
  select coalesce(points, 0) into v_bonus
    from player_gameweek_scores
   where league_id = v_league_id
     and gameweek_id = p_gameweek_id
     and player_id = case when coalesce(v_cap_played, false) then v_captain else v_vice end;

  return v_base + coalesce(v_bonus, 0);
end;
$$;

revoke all on function team_gameweek_points(uuid, uuid) from public;
grant execute on function team_gameweek_points(uuid, uuid) to authenticated, service_role;
