-- 0040_deferred_fixtures.sql
-- Keep a past gameweek editable while any of its matches is still to be played.
--
-- The Premier League does not play a full round every week. A gameweek can
-- close with two clubs yet to play, their match landing weeks later, and the
-- points still belong to that gameweek — so the result of a matchup settled in
-- August can change in October.
--
-- Rolling locks already handle the fairness half: a player locks at their own
-- kickoff, so someone whose match is deferred is still movable while everyone
-- else in that gameweek is frozen. What was missing is that you could not
-- reach that lineup — the team page always shows the current gameweek — and
-- that save_lineup rejected any historical lineup containing a player you had
-- since dropped.
--
-- Points follow the lineup, not current ownership, so a player you started in
-- gameweek 2 and dropped in gameweek 4 still scores for you when their
-- deferred match is finally played.

-- ------------------------------------------------------------ save_lineup ----
-- 0037's function with one rule changed: a starter must be on the roster OR
-- already in this gameweek's stored lineup.

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


-- ------------------------------------------------- what is still editable ----

create or replace function open_lineup_slots(p_team_id uuid)
returns table (
  gameweek_id     uuid,
  gameweek_number integer,
  player_id       uuid,
  display_name    text,
  kickoff_at      timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  -- Starters in a gameweek whose deadline has passed but whose own match has
  -- not kicked off. In an ordinary gameweek this is empty; it only returns
  -- anything when a club's fixture was deferred.
  select
    g.id,
    g.number,
    p.id,
    p.display_name,
    player_lock_time(p.id, g.id)
  from lineups l
  join gameweeks g       on g.id = l.gameweek_id
  join lineup_players lp on lp.lineup_id = l.id and lp.role = 'starter'
  join players p         on p.id = lp.player_id
  where l.fantasy_team_id = p_team_id
    and g.deadline_at <= now()
    -- Deliberately not coalesced. A null lock time means the club has no
    -- fixture in this gameweek at all, which is a blank week, not a deferred
    -- one: there is nothing to wait for and nothing to change. Coalescing to
    -- 'infinity' here — as save_lineup does, where it correctly means "never
    -- locks" — would leave that gameweek advertised as open forever.
    and player_lock_time(p.id, g.id) > now()
  order by g.number, p.display_name;
$$;

comment on function open_lineup_slots(uuid) is
  'Starters whose gameweek has started but whose own match has not, i.e. slots '
  'that can still be changed. Empty unless a fixture was deferred.';

revoke all on function open_lineup_slots(uuid) from public;
grant execute on function open_lineup_slots(uuid) to authenticated, service_role;

-- --------------------------------------------------- unfinished gameweeks ----
-- For the matchup page, so a score that can still move says so.

create or replace function gameweek_unplayed_fixtures(p_gameweek_id uuid)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::integer
    from fixtures f
   where f.gameweek_id = p_gameweek_id
     and f.status <> 'finished';
$$;

revoke all on function gameweek_unplayed_fixtures(uuid) from public;
grant execute on function gameweek_unplayed_fixtures(uuid) to authenticated, service_role;
