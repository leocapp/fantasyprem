-- 0036_projected_points_bulk.sql
-- Every projected score for a gameweek in one call.
--
-- projected_points() answers for one player, which is fine on a player page but
-- useless for sorting a list: ordering six hundred free agents by projection
-- would mean six hundred round trips, and the page can't sort by a value it
-- only has for the twenty-five rows it already decided to show.
--
-- Same function, same rules, applied across the gameweek's expectations.

create or replace function projected_points_for_league(
  p_league_id   uuid,
  p_gameweek_id uuid
)
returns table (player_id uuid, points numeric)
language sql
security definer
stable
set search_path = public
as $$
  select e.player_id,
         projected_points(p_league_id, e.player_id, p_gameweek_id)
    from player_gameweek_expectations e
   where e.gameweek_id = p_gameweek_id;
$$;

comment on function projected_points_for_league(uuid, uuid) is
  'Projected points for every player with an expectation for this gameweek, '
  'under this league''s scoring rules. For sorting lists; use projected_points '
  'for a single player.';

revoke all on function projected_points_for_league(uuid, uuid) from public;
grant execute on function projected_points_for_league(uuid, uuid) to authenticated, service_role;
