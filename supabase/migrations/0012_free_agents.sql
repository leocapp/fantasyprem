-- 0012_free_agents.sql
-- Swapping a rostered player for a free agent.
--
-- Drop and add happen together, never separately: an incomplete squad is
-- never a valid state, and a like-for-like swap keeps every team at exactly
-- its position quotas, so a legal XI stays possible without any extra checks.

create or replace function swap_player(
  p_league_id      uuid,
  p_drop_player_id uuid,
  p_add_player_id  uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_team_id       uuid;
  v_status        league_status;
  v_drop_position player_position;
  v_add_position  player_position;
  v_entry_id      uuid;
  v_cleared       integer;
begin
  select status into v_status from leagues where id = p_league_id;

  if v_status is null then
    raise exception 'League not found.';
  end if;

  if v_status <> 'active' then
    raise exception 'Transfers are only allowed once the draft is complete.';
  end if;

  select id into v_team_id
    from fantasy_teams
   where league_id = p_league_id and owner_id = auth.uid();

  if v_team_id is null then
    raise exception 'You do not have a team in this league.';
  end if;

  if p_drop_player_id = p_add_player_id then
    raise exception 'Pick a different player to add.';
  end if;

  -- Lock the roster row so two swaps cannot both drop the same player.
  select id into v_entry_id
    from roster_entries
   where fantasy_team_id = v_team_id
     and player_id = p_drop_player_id
     and dropped_at is null
   for update;

  if v_entry_id is null then
    raise exception 'That player is not on your roster.';
  end if;

  select position into v_drop_position from players where id = p_drop_player_id;
  select position into v_add_position  from players where id = p_add_player_id and is_active;

  if v_add_position is null then
    raise exception 'That player is not available.';
  end if;

  if v_drop_position <> v_add_position then
    raise exception 'Swaps must be like for like — drop a % to add a %.',
      v_drop_position, v_drop_position;
  end if;

  if exists (
    select 1 from roster_entries
     where league_id = p_league_id
       and player_id = p_add_player_id
       and dropped_at is null
  ) then
    raise exception 'That player is already on a roster in this league.';
  end if;

  update roster_entries set dropped_at = now() where id = v_entry_id;

  -- The partial unique index on (league_id, player_id) where dropped_at is
  -- null is the real guarantee here: if another manager claimed this player a
  -- moment ago, this insert fails rather than duplicating ownership.
  insert into roster_entries (league_id, fantasy_team_id, player_id, acquired_via)
  values (p_league_id, v_team_id, p_add_player_id, 'free_agent');

  insert into transactions (
    league_id, fantasy_team_id, type, player_in_id, player_out_id, created_by
  )
  values (p_league_id, v_team_id, 'add', p_add_player_id, p_drop_player_id, auth.uid());

  -- Any unlocked lineup naming the dropped player is now illegal. Clearing it
  -- forces a deliberate re-pick rather than silently fielding ten players.
  with affected as (
    select l.id
      from lineups l
      join gameweeks g on g.id = l.gameweek_id
      join lineup_players lp on lp.lineup_id = l.id
     where l.fantasy_team_id = v_team_id
       and g.deadline_at > now()
       and lp.player_id = p_drop_player_id
  )
  delete from lineups where id in (select id from affected);

  get diagnostics v_cleared = row_count;

  if v_cleared > 0 then
    raise notice 'Cleared % upcoming lineup(s) containing the dropped player.', v_cleared;
  end if;

  return v_team_id;
end;
$$;

revoke all on function swap_player(uuid, uuid, uuid) from public;
grant execute on function swap_player(uuid, uuid, uuid) to authenticated;
