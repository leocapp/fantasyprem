-- 0037_rolling_lineup_locks.sql
-- Lineups stay editable through the gameweek; players lock when they kick off.
--
-- Previously the whole lineup froze at the deadline, so a starter ruled out in
-- the warm-up of a Sunday match was a dead slot from Saturday morning. Now a
-- player is locked only once his own club has kicked off, and everyone else can
-- still be moved.
--
-- The captain is the exception: fixed at the gameweek deadline. Swapping the
-- armband after watching Saturday's results is a far bigger swing than a bench
-- change, and it would reward whoever happens to be at home on a Saturday
-- rather than whoever picked the better squad.
--
-- All of this is enforced here rather than in the page, so a stale tab or a
-- crafted request can't move a player who is already on the pitch.

-- --------------------------------------------------------- when they lock ----

create or replace function player_lock_time(
  p_player_id   uuid,
  p_gameweek_id uuid
)
returns timestamptz
language sql
stable
security definer
set search_path = public
as $$
  -- Earliest kickoff among their club's fixtures this gameweek. Earliest
  -- rather than latest because in a double gameweek the first whistle is the
  -- point after which anything you do is informed by having watched them.
  --
  -- The scheduled time is the primary signal rather than anything the
  -- ingestion observes: the cron runs every twenty minutes at best and GitHub
  -- drops roughly a third of its runs, so waiting to see stats would leave a
  -- window where a match is live and its players are still movable.
  --
  -- A fixture we already know has started or finished locks immediately,
  -- whatever the clock says. That covers the one asymmetric failure — a match
  -- brought forward before the hourly refresh notices — where the scheduled
  -- time alone would lock too late. Locking early is harmless; locking late is
  -- exploitable.
  select min(
           case
             when f.status in ('live', 'finished') then '-infinity'::timestamptz
             else f.kickoff_at
           end
         )
    from fixtures f
    join players p on p.club_id in (f.home_club_id, f.away_club_id)
   where p.id = p_player_id
     and f.gameweek_id = p_gameweek_id;
$$;

comment on function player_lock_time(uuid, uuid) is
  'When this player becomes unmovable for this gameweek: their club''s first '
  'kickoff. Null means no fixture, so they never lock.';

revoke all on function player_lock_time(uuid, uuid) from public;
grant execute on function player_lock_time(uuid, uuid) to authenticated, service_role;

-- ------------------------------------------------------------ save_lineup ----

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

  select count(*) into v_on_roster
    from roster_entries
   where fantasy_team_id = p_team_id
     and dropped_at is null
     and player_id = any (p_starters);

  if v_on_roster <> 11 then
    raise exception 'Every starter must be on your roster.';
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

  select id into v_lineup_id
    from lineups
   where fantasy_team_id = p_team_id and gameweek_id = p_gameweek_id;

  v_existing := v_lineup_id is not null;

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

  insert into lineup_players (lineup_id, player_id, role, bench_order)
  select
    v_lineup_id,
    re.player_id,
    'bench',
    row_number() over (order by p.position, p.display_name)
  from roster_entries re
  join players p on p.id = re.player_id
  where re.fantasy_team_id = p_team_id
    and re.dropped_at is null
    and not (re.player_id = any (p_starters));

  return v_lineup_id;
end;
$$;

revoke all on function save_lineup(uuid, uuid, text, uuid[], uuid, uuid) from public;
grant execute on function save_lineup(uuid, uuid, text, uuid[], uuid, uuid)
  to authenticated, service_role;
