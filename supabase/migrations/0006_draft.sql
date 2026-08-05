-- 0006_draft.sql
-- Running a snake draft.
--
-- All three functions are SECURITY DEFINER and authorise the caller
-- themselves. draft_picks deliberately has no user-facing write policy, so
-- these functions are the only way picks can be made.

-- ----------------------------------------------------- set draft order ----
-- Optional. The commissioner passes team ids in the order they should pick.
-- Skip it and start_draft() shuffles instead.

create or replace function set_draft_order(p_league_id uuid, p_team_ids uuid[])
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status league_status;
  v_count  integer;
begin
  select status into v_status from leagues
   where id = p_league_id and commissioner_id = auth.uid();

  if not found then
    raise exception 'Only the commissioner can set the draft order.';
  end if;

  if v_status <> 'setup' then
    raise exception 'The draft order is locked once the draft has started.';
  end if;

  select count(*) into v_count from fantasy_teams where league_id = p_league_id;

  if v_count <> array_length(p_team_ids, 1) then
    raise exception 'Draft order must include every team exactly once.';
  end if;

  -- Clear first: draft_position is uniquely indexed per league, so shuffling
  -- in place would collide.
  update fantasy_teams set draft_position = null where league_id = p_league_id;

  update fantasy_teams t
     set draft_position = ordered.position
    from (
      select unnest(p_team_ids) as team_id,
             generate_subscripts(p_team_ids, 1) as position
    ) ordered
   where t.id = ordered.team_id
     and t.league_id = p_league_id;

  if exists (
    select 1 from fantasy_teams
     where league_id = p_league_id and draft_position is null
  ) then
    raise exception 'Draft order must include every team exactly once.';
  end if;
end;
$$;

-- ---------------------------------------------------------- start draft ----

create or replace function start_draft(p_league_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_league     leagues%rowtype;
  v_team_count integer;
  v_rounds     integer;
begin
  select * into v_league from leagues
   where id = p_league_id and commissioner_id = auth.uid();

  if not found then
    raise exception 'Only the commissioner can start the draft.';
  end if;

  if v_league.status <> 'setup' then
    raise exception 'This draft has already started.';
  end if;

  select count(*) into v_team_count from fantasy_teams where league_id = p_league_id;

  if v_team_count < 2 then
    raise exception 'A draft needs at least two teams.';
  end if;

  -- Randomise unless the commissioner has already arranged the order.
  if exists (
    select 1 from fantasy_teams
     where league_id = p_league_id and draft_position is null
  ) then
    update fantasy_teams t
       set draft_position = shuffled.position
      from (
        select id, row_number() over (order by random()) as position
          from fantasy_teams
         where league_id = p_league_id
      ) shuffled
     where t.id = shuffled.id;
  end if;

  v_rounds := v_league.roster_size;

  -- Snake: odd rounds run 1..n, even rounds run n..1.
  insert into draft_picks (league_id, round, pick_in_round, overall_pick, fantasy_team_id)
  select
    p_league_id,
    r.round,
    s.pick_in_round,
    (r.round - 1) * v_team_count + s.pick_in_round,
    t.id
  from generate_series(1, v_rounds) as r (round)
  cross join generate_series(1, v_team_count) as s (pick_in_round)
  cross join lateral (
    select id
      from fantasy_teams
     where league_id = p_league_id
     order by draft_position
     offset case when r.round % 2 = 1
                 then s.pick_in_round - 1
                 else v_team_count - s.pick_in_round
            end
     limit 1
  ) t;

  update leagues set status = 'drafting' where id = p_league_id;

  return v_rounds * v_team_count;
end;
$$;

-- ------------------------------------------------------------ make pick ----

create or replace function make_pick(p_league_id uuid, p_player_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_team_id uuid;
  v_pick    draft_picks%rowtype;
  v_status  league_status;
begin
  select status into v_status from leagues where id = p_league_id;

  if v_status is null then
    raise exception 'League not found.';
  end if;

  if v_status <> 'drafting' then
    raise exception 'This league is not drafting.';
  end if;

  select id into v_team_id
    from fantasy_teams
   where league_id = p_league_id and owner_id = auth.uid();

  if v_team_id is null then
    raise exception 'You do not have a team in this league.';
  end if;

  -- FOR UPDATE serialises simultaneous picks: the second caller waits, then
  -- re-reads and finds the pick already filled.
  select * into v_pick
    from draft_picks
   where league_id = p_league_id and player_id is null
   order by overall_pick
   limit 1
   for update;

  if not found then
    raise exception 'The draft is already complete.';
  end if;

  if v_pick.fantasy_team_id <> v_team_id then
    raise exception 'It is not your turn to pick.';
  end if;

  if not exists (select 1 from players where id = p_player_id and is_active) then
    raise exception 'That player is not available.';
  end if;

  if exists (
    select 1 from roster_entries
     where league_id = p_league_id
       and player_id = p_player_id
       and dropped_at is null
  ) then
    raise exception 'That player has already been drafted.';
  end if;

  update draft_picks
     set player_id = p_player_id, picked_at = now()
   where id = v_pick.id;

  insert into roster_entries (league_id, fantasy_team_id, player_id, acquired_via)
  values (p_league_id, v_team_id, p_player_id, 'draft');

  insert into transactions (league_id, fantasy_team_id, type, player_in_id, created_by)
  values (p_league_id, v_team_id, 'draft', p_player_id, auth.uid());

  if not exists (
    select 1 from draft_picks where league_id = p_league_id and player_id is null
  ) then
    update leagues set status = 'active' where id = p_league_id;
  end if;

  return v_pick.overall_pick;
end;
$$;

-- ---------------------------------------------------------------- grants ----

revoke all on function set_draft_order(uuid, uuid[]) from public;
revoke all on function start_draft(uuid) from public;
revoke all on function make_pick(uuid, uuid) from public;

grant execute on function set_draft_order(uuid, uuid[]) to authenticated;
grant execute on function start_draft(uuid) to authenticated;
grant execute on function make_pick(uuid, uuid) to authenticated;

-- -------------------------------------------------------------- realtime ----
-- Push pick changes to connected clients. Realtime still applies RLS, so only
-- league members receive them.

do $$
begin
  alter publication supabase_realtime add table draft_picks;
exception
  when duplicate_object then null;
end;
$$;
