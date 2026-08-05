-- 0008_lineups.sql
-- Setting a starting XI.
--
-- The whole lineup is saved in one call. Validating a partial lineup is
-- meaningless (ten players is never legal), so there is no incremental API.

-- ---------------------------------------------------------- formations ----
-- Always one goalkeeper, so only the outfield split is stored.

create table formations (
  code        text primary key,
  defenders   integer not null,
  midfielders integer not null,
  forwards    integer not null,
  sort_order  integer not null,
  check (defenders + midfielders + forwards = 10),
  check (defenders between 3 and 5),
  check (forwards >= 1)
);

insert into formations (code, defenders, midfielders, forwards, sort_order) values
  ('3-4-3', 3, 4, 3, 1),
  ('3-5-2', 3, 5, 2, 2),
  ('4-3-3', 4, 3, 3, 3),
  ('4-4-2', 4, 4, 2, 4),
  ('4-5-1', 4, 5, 1, 5),
  ('5-2-3', 5, 2, 3, 6),
  ('5-3-2', 5, 3, 2, 7),
  ('5-4-1', 5, 4, 1, 8);

alter table formations enable row level security;

create policy "formations readable by signed-in users"
  on formations for select to authenticated using (true);

-- --------------------------------------------------------- save lineup ----

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

  -- Checked here rather than in the UI so a stale tab cannot bypass it.
  if v_deadline <= now() then
    raise exception 'The deadline for this gameweek has passed.';
  end if;

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

  insert into lineups (fantasy_team_id, gameweek_id, formation)
  values (p_team_id, p_gameweek_id, p_formation)
  on conflict (fantasy_team_id, gameweek_id)
  do update set formation = excluded.formation
  returning id into v_lineup_id;

  -- Simpler to rebuild than to diff.
  delete from lineup_players where lineup_id = v_lineup_id;

  insert into lineup_players (lineup_id, player_id, role, is_captain, is_vice_captain)
  select v_lineup_id, s.player_id, 'starter', s.player_id = p_captain, s.player_id = p_vice
    from unnest(p_starters) as s (player_id);

  -- Everyone else on the roster becomes the bench, in a stable order.
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
grant execute on function save_lineup(uuid, uuid, text, uuid[], uuid, uuid) to authenticated;
