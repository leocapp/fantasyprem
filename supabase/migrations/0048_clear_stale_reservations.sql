-- 0048_clear_stale_reservations.sql
-- A recovered player's reservation was still blocking the spot.
--
-- 0047 made the *slot* derived — reserved_at only counts while the player is
-- still out — but left reserved_at itself lying around once he was cleared.
-- Two things then read it literally:
--
--   * roster_entries_one_reserve, the unique index, which sees any non-null
--     reserved_at on the team; and
--   * the "you already have a player on injury reserve" check.
--
-- So: Salah is reserved, Sportmonks clears him, you drop somebody else to get
-- back under the limit, and now your reserve spot is permanently occupied by a
-- fit player. The next injury can't be reserved at all, and the error message
-- names a man who has been playing for a fortnight.
--
-- The fix is to tidy the stale row on the way in. This is the same mistake in
-- miniature as the one 0047's comment is about — deriving the interesting part
-- and then leaving a literal copy behind for something else to trip over.

create or replace function set_injury_reserve(
  p_league_id uuid,
  p_player_id uuid,
  p_reserved  boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_team_id  uuid;
  v_entry_id uuid;
  v_avail    text;
  v_name     text;
  v_holder   text;
  v_cleared  integer;
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

  -- Coming off is always allowed, and needs no checks: it can only ever make
  -- the roster more legal, and a manager who wants his fit striker back before
  -- the system notices should not be stopped.
  if not coalesce(p_reserved, false) then
    update roster_entries set reserved_at = null where id = v_entry_id;
    return;
  end if;

  select availability, display_name into v_avail, v_name
    from players where id = p_player_id;

  if v_avail is null or v_avail not in ('i', 's') then
    raise exception
      '% is not injured or suspended, so cannot go on injury reserve.',
      coalesce(v_name, 'That player');
  end if;

  -- Release any reservation that has already expired. The player went back to
  -- taking an ordinary roster slot the moment he was cleared, so this changes
  -- nothing about the team — it only stops a dead row holding the spot and
  -- tripping the unique index below.
  update roster_entries re
     set reserved_at = null
    from players p
   where p.id = re.player_id
     and re.fantasy_team_id = v_team_id
     and re.dropped_at is null
     and re.reserved_at is not null
     and re.id <> v_entry_id
     and (p.availability is null or p.availability not in ('i', 's'));

  -- Whatever survived that is a genuine reservation, and there is only one spot.
  select p.display_name into v_holder
    from roster_entries re
    join players p on p.id = re.player_id
   where re.fantasy_team_id = v_team_id
     and re.dropped_at is null
     and re.reserved_at is not null
     and re.id <> v_entry_id;

  if v_holder is not null then
    raise exception
      '% is already on injury reserve — there is only one spot. Activate him first.',
      v_holder;
  end if;

  update roster_entries set reserved_at = now() where id = v_entry_id;

  -- Same reasoning as swap_player: a lineup naming a reserved player is now
  -- illegal, and clearing it forces a deliberate re-pick rather than quietly
  -- fielding ten. Only lineups that can still be changed.
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
    raise notice 'Cleared % upcoming lineup(s) naming the reserved player.', v_cleared;
  end if;
end;
$$;

revoke all on function set_injury_reserve(uuid, uuid, boolean) from public;
grant execute on function set_injury_reserve(uuid, uuid, boolean) to authenticated;

-- Nothing to backfill: no reservation has ever been made, so there is no stale
-- row in the wild yet. This lands before the first one can go stale.
