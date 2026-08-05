-- 0009_position_quotas.sql
-- Squad composition rules: a fixed number of squad slots per position.
--
-- Because the slots sum to roster_size, capping each position is enough on its
-- own — nobody can over-fill a position, so by the final round every position
-- is exactly filled and a legal XI is always possible. No lookahead needed.

alter table leagues
  add column if not exists slots_gk  integer not null default 2,
  add column if not exists slots_def integer not null default 5,
  add column if not exists slots_mid integer not null default 5,
  add column if not exists slots_fwd integer not null default 5;

alter table leagues
  add constraint leagues_slots_positive
  check (slots_gk >= 1 and slots_def >= 3 and slots_mid >= 3 and slots_fwd >= 1);

-- Bring leagues that haven't drafted yet in line with the new defaults.
update leagues
   set roster_size = slots_gk + slots_def + slots_mid + slots_fwd
 where status = 'setup';

-- NOT VALID: existing drafted leagues keep their old roster_size without
-- blocking this migration, but every new or updated row is checked.
alter table leagues
  add constraint leagues_roster_size_matches_slots
  check (roster_size = slots_gk + slots_def + slots_mid + slots_fwd)
  not valid;

-- ---------------------------------------------- create league (updated) ----
-- roster_size is now derived from the slots rather than passed in.

drop function if exists create_league(text, text, integer, integer);

create or replace function create_league(
  p_name       text,
  p_team_name  text,
  p_max_teams  integer default 10,
  p_slots_gk   integer default 2,
  p_slots_def  integer default 5,
  p_slots_mid  integer default 5,
  p_slots_fwd  integer default 5
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_season_id uuid;
  v_league_id uuid;
begin
  if auth.uid() is null then
    raise exception 'You must be signed in to create a league.';
  end if;

  select id into v_season_id from seasons where is_current limit 1;
  if v_season_id is null then
    raise exception 'No current season is configured.';
  end if;

  insert into leagues (
    name, season_id, commissioner_id, max_teams,
    slots_gk, slots_def, slots_mid, slots_fwd, roster_size
  )
  values (
    trim(p_name), v_season_id, auth.uid(), p_max_teams,
    p_slots_gk, p_slots_def, p_slots_mid, p_slots_fwd,
    p_slots_gk + p_slots_def + p_slots_mid + p_slots_fwd
  )
  returning id into v_league_id;

  insert into fantasy_teams (league_id, owner_id, name)
  values (v_league_id, auth.uid(), trim(p_team_name));

  return v_league_id;
end;
$$;

revoke all on function create_league(text, text, integer, integer, integer, integer, integer) from public;
grant execute on function create_league(text, text, integer, integer, integer, integer, integer) to authenticated;

-- -------------------------------------------------- make pick (updated) ----

create or replace function make_pick(p_league_id uuid, p_player_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_team_id  uuid;
  v_pick     draft_picks%rowtype;
  v_league   leagues%rowtype;
  v_position player_position;
  v_limit    integer;
  v_held     integer;
begin
  select * into v_league from leagues where id = p_league_id;

  if not found then
    raise exception 'League not found.';
  end if;

  if v_league.status <> 'drafting' then
    raise exception 'This league is not drafting.';
  end if;

  select id into v_team_id
    from fantasy_teams
   where league_id = p_league_id and owner_id = auth.uid();

  if v_team_id is null then
    raise exception 'You do not have a team in this league.';
  end if;

  -- FOR UPDATE serialises simultaneous picks.
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

  select position into v_position from players where id = p_player_id and is_active;

  if v_position is null then
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

  v_limit := case v_position
               when 'GK'  then v_league.slots_gk
               when 'DEF' then v_league.slots_def
               when 'MID' then v_league.slots_mid
               when 'FWD' then v_league.slots_fwd
             end;

  select count(*) into v_held
    from roster_entries re
    join players p on p.id = re.player_id
   where re.fantasy_team_id = v_team_id
     and re.dropped_at is null
     and p.position = v_position;

  if v_held >= v_limit then
    raise exception 'Your squad already has % of % % — pick a different position.',
      v_held, v_limit, v_position;
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

revoke all on function make_pick(uuid, uuid) from public;
grant execute on function make_pick(uuid, uuid) to authenticated;
