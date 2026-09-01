-- 0051_claim_against_roster_size.sql
-- claim_player has never worked. It reads columns that were renamed in 0014.
--
-- 0047 built it against leagues.slots_gk / slots_def / slots_mid / slots_fwd,
-- treating them as per-position caps. 0014 renamed those to min_gk / min_def /
-- min_mid / min_fwd and inverted their meaning: they are floors now, not
-- ceilings, and roster_size is the only cap. The same migration rewrote
-- swap_player to allow any player for any other, so the like-for-like rationale
-- in 0047's header describes a rule that had already been gone for months.
--
-- PL/pgSQL doesn't resolve column names until the function runs, so 0047
-- applied cleanly and every attempt to sign a free agent into a reserved slot
-- failed with "column slots_gk does not exist". The feature was released broken
-- and looked, from outside, like the button doing nothing.
--
-- I took 0012's comment as current without checking whether a later migration
-- had superseded it. That is the same failure this project keeps producing —
-- reading something once and never asking whether it is still true.

-- --------------------------------------------------------- claim a player ----
-- Under minimums there is no per-position question to ask. Adding a player can
-- never break a floor; it can only break the total. So the check is simply
-- whether there is a place free, which is only the case when somebody is on
-- injury reserve — reserved players don't count towards the active roster.

create or replace function claim_player(p_league_id uuid, p_add_player_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_team_id uuid;
  v_status  league_status;
  v_size    integer;
  v_active  integer;
begin
  select status, roster_size into v_status, v_size
    from leagues where id = p_league_id;

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

  if not exists (select 1 from players where id = p_add_player_id and is_active) then
    raise exception 'That player is not available.';
  end if;

  if exists (
    select 1 from roster_entries
     where league_id = p_league_id
       and player_id = p_add_player_id
       and dropped_at is null
  ) then
    raise exception 'That player is already on a roster in this league.';
  end if;

  select count(*) into v_active
    from roster_slots
   where fantasy_team_id = v_team_id
     and not is_reserved;

  if v_active >= v_size then
    raise exception
      'Your squad is full at % players. Put an injured player on reserve to free a place, or swap instead of signing.',
      v_size;
  end if;

  -- The partial unique index on (league_id, player_id) where dropped_at is null
  -- is what actually stops two managers claiming the same player at once.
  insert into roster_entries (league_id, fantasy_team_id, player_id, acquired_via)
  values (p_league_id, v_team_id, p_add_player_id, 'free_agent');

  insert into transactions (league_id, fantasy_team_id, type, player_in_id, created_by)
  values (p_league_id, v_team_id, 'add', p_add_player_id, auth.uid());

  return v_team_id;
end;
$$;

comment on function claim_player(uuid, uuid) is
  'Sign a free agent into a place left open by injury reserve. Refuses unless '
  'the active roster is genuinely under roster_size. Any position: minimums are '
  'floors, and signing cannot breach a floor.';

revoke all on function claim_player(uuid, uuid) from public;
grant execute on function claim_player(uuid, uuid) to authenticated;

-- ---------------------------------------------------------- drop a player ----
-- Dropping *can* breach a floor, and 0047's version didn't check. A team one
-- over the limit could drop its way below the minimum number of goalkeepers and
-- then be unable to field a legal XI at all — trading one blocked lineup for a
-- worse one.
--
-- squad_minimum_violation is the same helper swaps and trades use, so the rule
-- stays in one place.

create or replace function drop_player(p_league_id uuid, p_player_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_team_id   uuid;
  v_entry_id  uuid;
  v_active    integer;
  v_size      integer;
  v_violation text;
  v_cleared   integer;
begin
  select id into v_team_id
    from fantasy_teams
   where league_id = p_league_id and owner_id = auth.uid();

  if v_team_id is null then
    raise exception 'You do not have a team in this league.';
  end if;

  select id into v_entry_id
    from roster_entries
   where fantasy_team_id = v_team_id
     and player_id = p_player_id
     and dropped_at is null
   for update;

  if v_entry_id is null then
    raise exception 'That player is not on your roster.';
  end if;

  select roster_size into v_size from leagues where id = p_league_id;

  select count(*) into v_active
    from roster_slots
   where fantasy_team_id = v_team_id
     and not is_reserved;

  if v_active <= v_size then
    raise exception
      'Your roster is not over the limit, so dropping would leave you short. Swap instead.';
  end if;

  v_violation := squad_minimum_violation(v_team_id, array[p_player_id], '{}');

  if v_violation is not null then
    raise exception 'Dropping them would leave you below the minimum of %.', v_violation;
  end if;

  update roster_entries set dropped_at = now() where id = v_entry_id;

  insert into transactions (league_id, fantasy_team_id, type, player_out_id, created_by)
  values (p_league_id, v_team_id, 'drop', p_player_id, auth.uid());

  with affected as (
    select l.id
      from lineups l
      join gameweeks g on g.id = l.gameweek_id
      join lineup_players lp on lp.lineup_id = l.id
     where l.fantasy_team_id = v_team_id
       and g.deadline_at > now()
       and lp.player_id = p_player_id
  )
  delete from lineups where id in (select id from affected);

  get diagnostics v_cleared = row_count;

  if v_cleared > 0 then
    raise notice 'Cleared % upcoming lineup(s) containing the dropped player.', v_cleared;
  end if;

  return v_team_id;
end;
$$;

comment on function drop_player(uuid, uuid) is
  'Release a player without signing one, to get back under roster_size after a '
  'reserved player was cleared to play. Refuses unless the team is over, and '
  'refuses to drop below a positional minimum.';

revoke all on function drop_player(uuid, uuid) from public;
grant execute on function drop_player(uuid, uuid) to authenticated;
