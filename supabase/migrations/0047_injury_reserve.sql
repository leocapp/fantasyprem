-- 0047_injury_reserve.sql
-- One roster spot per team that doesn't count, for a player the provider has
-- ruled out.
--
-- The point is insurance, not a bigger squad. Lose a striker for three months
-- and you can park him and sign a replacement, instead of choosing between
-- carrying a passenger and cutting a player you drafted in the second round.
--
-- Two decisions shape everything below.
--
-- Eligibility is the provider's, not the manager's: availability must be 'i'
-- or 's'. Without that gate everybody reserves a rotation squad player in
-- August and never touches it again, which is just roster_size + 1 with extra
-- clicks. 'd' — doubtful — deliberately doesn't qualify: a doubtful player may
-- well start, and reserving him would be a free slot bought on a maybe.
--
-- And the reservation is *derived*, not stored as a state. reserved_at records
-- that the manager put him there; whether it still counts is recomputed from
-- the player's current availability every time anything looks. So the moment
-- Sportmonks clears him he occupies a normal slot again, the roster goes one
-- over, and save_lineup refuses until someone is dropped. Nothing has to
-- notice, no job has to run, and there is no stored flag to drift out of date.
-- This codebase has enough of those already.

-- ----------------------------------------------------------- the column ----

alter table roster_entries
  add column if not exists reserved_at timestamptz;

comment on column roster_entries.reserved_at is
  'When the manager put this player on injury reserve. Non-null is intent, not '
  'entitlement: the slot only stops counting while players.availability is '
  'still ''i'' or ''s''. See the roster_slots view.';

-- One spot per team. Partial so that dropped rows and ordinary roster rows
-- don't collide, and it is the real guarantee — the check in
-- set_injury_reserve exists for the error message, this exists for the race.
create unique index if not exists roster_entries_one_reserve
  on roster_entries (fantasy_team_id)
  where reserved_at is not null and dropped_at is null;

-- ---------------------------------------------------------------- slots ----
-- The single place that answers "is this row taking up a roster slot". Every
-- count in the schema goes through it, so the rule can never be spelled two
-- slightly different ways in two different functions — which is how the
-- gameweek status and is_active bugs both happened.

create or replace view roster_slots as
select
  re.id,
  re.league_id,
  re.fantasy_team_id,
  re.player_id,
  re.acquired_via,
  re.acquired_at,
  re.reserved_at,
  p.position,
  p.availability,
  p.expected_return,
  (re.reserved_at is not null and p.availability in ('i', 's')) as is_reserved
from roster_entries re
join players p on p.id = re.player_id
where re.dropped_at is null;

alter view roster_slots set (security_invoker = on);

comment on view roster_slots is
  'Active roster rows with the injury-reserve rule applied. is_reserved is '
  'false for a reserved player the provider has since cleared, which is what '
  'puts his team over the limit until they drop somebody.';

grant select on roster_slots to authenticated;

-- ------------------------------------------------------- on and off IR ----

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

  if exists (
    select 1 from roster_entries
     where fantasy_team_id = v_team_id
       and dropped_at is null
       and reserved_at is not null
       and id <> v_entry_id
  ) then
    raise exception 'You already have a player on injury reserve — there is only one spot.';
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

comment on function set_injury_reserve(uuid, uuid, boolean) is
  'Move one of your players on or off the injury reserve spot. Going on '
  'requires the provider to have him injured or suspended; coming off is '
  'always allowed.';

revoke all on function set_injury_reserve(uuid, uuid, boolean) from public;
grant execute on function set_injury_reserve(uuid, uuid, boolean) to authenticated;

-- ------------------------------------------------- filling the free slot ----
-- swap_player is deliberately like-for-like, and its comment explains why: an
-- even swap keeps every team exactly on its position quotas, so a legal XI is
-- always possible without further checks. Injury reserve is the first thing
-- that opens a slot without closing one, so it needs an add with no drop.
--
-- The quota check does the like-for-like work on its own. Reserving a
-- midfielder leaves room under slots_mid and nowhere else, so the only player
-- who can be claimed is a midfielder — the same invariant, arrived at by
-- counting rather than by comparing two positions.

create or replace function claim_player(p_league_id uuid, p_add_player_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_team_id  uuid;
  v_status   league_status;
  v_position player_position;
  v_cap      integer;
  v_held     integer;
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

  select position into v_position
    from players where id = p_add_player_id and is_active;

  if v_position is null then
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

  select case v_position
           when 'GK'  then slots_gk
           when 'DEF' then slots_def
           when 'MID' then slots_mid
           else            slots_fwd
         end
    into v_cap
    from leagues where id = p_league_id;

  select count(*) into v_held
    from roster_slots
   where fantasy_team_id = v_team_id
     and position = v_position
     and not is_reserved;

  if v_held >= v_cap then
    raise exception
      'No room for another % — you already have %. Reserve an injured % first, or swap instead.',
      v_position, v_held, v_position;
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
  'Sign a free agent into a slot left open by injury reserve. Refuses unless '
  'the team is genuinely under its quota for that position.';

revoke all on function claim_player(uuid, uuid) from public;
grant execute on function claim_player(uuid, uuid) to authenticated;

-- ------------------------------------------------------ getting back under ----
-- Blocking the lineup is only fair if there is a way out of it, and there
-- wasn't one: swap_player always adds as it drops, so a team one over its limit
-- could not get back under. Hence a drop with no add.
--
-- Deliberately only available while over the limit. Dropping from a legal
-- roster would leave a team short and break the invariant swap_player exists to
-- protect — that a legal XI is always possible without anyone checking.

create or replace function drop_player(p_league_id uuid, p_player_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_team_id  uuid;
  v_entry_id uuid;
  v_active   integer;
  v_size     integer;
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

  select roster_size into v_size from leagues where id = p_league_id;

  select count(*) into v_active
    from roster_slots
   where fantasy_team_id = v_team_id
     and not is_reserved;

  if v_active <= v_size then
    raise exception
      'Your roster is not over the limit, so dropping would leave you short. Swap instead.';
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
  'reserved player was cleared to play. Refuses unless the team is over.';

revoke all on function drop_player(uuid, uuid) from public;
grant execute on function drop_player(uuid, uuid) to authenticated;

-- ----------------------------------------------------------- save_lineup ----
-- The definition from 0040 with three changes, all around the reserve:
--
--   * a reserved player cannot be named a starter;
--   * an over-size roster blocks the save entirely, which is what a returning
--     player triggers; and
--   * the bench is built from the active roster only, so a reserved player is
--     in neither XI nor bench — he is somewhere else, which is the point.

create or replace function save_lineup(
  p_team_id     uuid,
  p_gameweek_id uuid,
  p_formation   text,
  p_starters    uuid[],
  p_captain     uuid,
  p_vice        uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_league_id uuid;
  v_deadline  timestamptz;
  v_shape     formations%rowtype;
  v_lineup_id uuid;
  v_on_roster integer;
  v_gk        integer;
  v_def       integer;
  v_mid       integer;
  v_fwd       integer;
  v_locked    record;
  v_old_cap   uuid;
  v_old_vice  uuid;
  v_existing  boolean;
  v_active    integer;
  v_size      integer;
  v_returned  text;
  v_reserved  text;
begin
  select league_id into v_league_id
    from fantasy_teams
   where id = p_team_id and owner_id = auth.uid();

  if v_league_id is null then
    raise exception 'That is not your team.';
  end if;

  select deadline_at into v_deadline from gameweeks where id = p_gameweek_id;

  if v_deadline is null then
    raise exception 'Unknown gameweek.';
  end if;

  -- The gameweek no longer closes the lineup outright. What it closes is the
  -- armband, and any player whose match has started.

  select * into v_shape from formations where code = p_formation;

  if not found then
    raise exception 'Unknown formation: %', p_formation;
  end if;

  if coalesce(array_length(p_starters, 1), 0) <> 11 then
    raise exception 'Pick exactly 11 starters.';
  end if;

  if (select count(distinct s) from unnest(p_starters) as s) <> 11 then
    raise exception 'A player cannot start twice.';
  end if;

  -- Looked up here because the roster check below depends on it.
  select id into v_lineup_id
    from lineups
   where fantasy_team_id = p_team_id and gameweek_id = p_gameweek_id;

  v_existing := v_lineup_id is not null;

  -- A starter must be on the roster, or already in this gameweek's stored
  -- lineup. The second clause is what lets a past gameweek stay editable after
  -- an unrelated transfer: points follow the lineup rather than current
  -- ownership, so someone you started in gameweek 2 and have since dropped
  -- keeps scoring for you, and you can still fix a different slot without
  -- being blocked by their presence. It cannot be used to smuggle anyone in —
  -- they had to be on your roster when the lineup was first saved.
  select count(*) into v_on_roster
    from unnest(p_starters) as s (player_id)
   where exists (
           select 1 from roster_entries re
            where re.fantasy_team_id = p_team_id
              and re.dropped_at is null
              and re.player_id = s.player_id
         )
      or exists (
           select 1 from lineup_players lp
            where lp.lineup_id = v_lineup_id
              and lp.player_id = s.player_id
         );

  if v_on_roster <> 11 then
    raise exception 'Every starter must be on your roster.';
  end if;

  -- ------------------------------------------------------ injury reserve ----

  -- Someone already in the stored lineup is exempt, for the same reason as
  -- above: a deferred gameweek is resubmitted whole, and a player who has since
  -- been reserved would otherwise block an edit to an unrelated slot.
  select string_agg(p.display_name, ', ') into v_reserved
    from roster_slots rs
    join players p on p.id = rs.player_id
   where rs.fantasy_team_id = p_team_id
     and rs.is_reserved
     and rs.player_id = any (p_starters)
     and not exists (
           select 1 from lineup_players lp
            where lp.lineup_id = v_lineup_id
              and lp.player_id = rs.player_id
         );

  if v_reserved is not null then
    raise exception '% is on injury reserve and cannot start.', v_reserved;
  end if;

  select roster_size into v_size from leagues where id = v_league_id;

  select count(*) into v_active
    from roster_slots
   where fantasy_team_id = p_team_id
     and not is_reserved;

  if v_active > v_size then
    -- Almost always because a reserved player was cleared by the provider and
    -- silently took his slot back. Name him, or the manager has to work out for
    -- himself why a roster he never touched is suddenly illegal.
    select string_agg(p.display_name, ', ') into v_returned
      from roster_slots rs
      join players p on p.id = rs.player_id
     where rs.fantasy_team_id = p_team_id
       and rs.reserved_at is not null
       and not rs.is_reserved;

    if v_returned is not null then
      raise exception
        '% is fit again, so your roster is % over the limit. Drop someone, then set your lineup.',
        v_returned, v_active - v_size;
    end if;

    raise exception
      'Your roster is % over the limit of %. Drop someone before setting a lineup.',
      v_active - v_size, v_size;
  end if;

  select
    count(*) filter (where position = 'GK'),
    count(*) filter (where position = 'DEF'),
    count(*) filter (where position = 'MID'),
    count(*) filter (where position = 'FWD')
  into v_gk, v_def, v_mid, v_fwd
  from players
  where id = any (p_starters);

  if v_gk <> 1 then
    raise exception 'Pick exactly one goalkeeper.';
  end if;

  if v_def <> v_shape.defenders or v_mid <> v_shape.midfielders or v_fwd <> v_shape.forwards then
    raise exception
      '% needs % defenders, % midfielders and % forwards — you picked %, % and %.',
      p_formation, v_shape.defenders, v_shape.midfielders, v_shape.forwards, v_def, v_mid, v_fwd;
  end if;

  if p_captain is null or not (p_captain = any (p_starters)) then
    raise exception 'The captain must be one of your starters.';
  end if;

  if p_vice is null or not (p_vice = any (p_starters)) then
    raise exception 'The vice-captain must be one of your starters.';
  end if;

  if p_captain = p_vice then
    raise exception 'Captain and vice-captain must be different players.';
  end if;

  -- ------------------------------------------------------- rolling locks ----

  if v_existing then
    -- Any player whose match has started must be exactly where they were. This
    -- catches both directions at once: a started player can't be benched, and
    -- a started substitute can't be promoted.
    for v_locked in
      select p.display_name,
             lp.role = 'starter' as was_starting,
             lp.player_id = any (p_starters) as now_starting
        from lineup_players lp
        join players p on p.id = lp.player_id
       where lp.lineup_id = v_lineup_id
         and coalesce(player_lock_time(lp.player_id, p_gameweek_id), 'infinity') <= now()
    loop
      if v_locked.was_starting <> v_locked.now_starting then
        raise exception
          '% has already played this gameweek — you can no longer move them.',
          v_locked.display_name;
      end if;
    end loop;

    -- The armband is settled at the deadline, whether or not that player has
    -- kicked off yet.
    if now() >= v_deadline then
      select
        (array_agg(player_id) filter (where is_captain))[1],
        (array_agg(player_id) filter (where is_vice_captain))[1]
      into v_old_cap, v_old_vice
      from lineup_players
      where lineup_id = v_lineup_id;

      if v_old_cap is not null and p_captain is distinct from v_old_cap then
        raise exception 'The captain is fixed once the gameweek starts.';
      end if;

      if v_old_vice is not null and p_vice is distinct from v_old_vice then
        raise exception 'The vice-captain is fixed once the gameweek starts.';
      end if;
    end if;

  elsif now() >= v_deadline then
    -- No lineup was ever saved and the gameweek has begun. Anyone already
    -- playing can't be picked now — that would be choosing a starter having
    -- seen him play.
    if exists (
      select 1
        from unnest(p_starters) as s (player_id)
       where coalesce(player_lock_time(s.player_id, p_gameweek_id), 'infinity') <= now()
    ) then
      raise exception
        'Some of those players have already kicked off. Pick from those still to play.';
    end if;
  end if;

  -- --------------------------------------------------------------- write ----

  insert into lineups (fantasy_team_id, gameweek_id, formation)
  values (p_team_id, p_gameweek_id, p_formation)
  on conflict (fantasy_team_id, gameweek_id)
  do update set formation = excluded.formation
  returning id into v_lineup_id;

  delete from lineup_players where lineup_id = v_lineup_id;

  insert into lineup_players (lineup_id, player_id, role, is_captain, is_vice_captain)
  select v_lineup_id, s.player_id, 'starter', s.player_id = p_captain, s.player_id = p_vice
    from unnest(p_starters) as s (player_id);

  -- The bench is the active roster minus the XI. A reserved player is in
  -- neither: he is not a substitute you could bring on, he is set aside.
  insert into lineup_players (lineup_id, player_id, role, bench_order)
  select
    v_lineup_id,
    rs.player_id,
    'bench',
    row_number() over (order by rs.position, p.display_name)
  from roster_slots rs
  join players p on p.id = rs.player_id
  where rs.fantasy_team_id = p_team_id
    and not rs.is_reserved
    and not (rs.player_id = any (p_starters));

  return v_lineup_id;
end;
$$;

revoke all on function save_lineup(uuid, uuid, text, uuid[], uuid, uuid) from public;
grant execute on function save_lineup(uuid, uuid, text, uuid[], uuid, uuid)
  to authenticated, service_role;

-- ------------------------------------------------------------- verify ----
-- Nobody should be over their limit the moment this lands. If anyone is, it is
-- a pre-existing roster problem rather than anything reserve-related, because
-- no reservations exist yet.

do $$
declare
  v_over integer;
begin
  select count(*) into v_over
    from (
      select rs.fantasy_team_id
        from roster_slots rs
        join fantasy_teams ft on ft.id = rs.fantasy_team_id
        join leagues l on l.id = ft.league_id
       where not rs.is_reserved
       group by rs.fantasy_team_id, l.roster_size
      having count(*) > max(l.roster_size)
    ) as over_limit;

  if v_over > 0 then
    raise warning
      '% team(s) are already over roster_size and will not be able to save a lineup.',
      v_over;
  end if;
end $$;
