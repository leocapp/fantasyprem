-- 0019_league_admin.sql
-- Co-commissioners, removing managers, and resetting a league.
--
-- leagues.commissioner_id stays as the league's owner: they can't be removed,
-- and only they can promote or demote. Co-commissioners get every other
-- commissioner power, which is what is_league_commissioner() already gates.

create table league_commissioners (
  league_id  uuid not null references leagues (id) on delete cascade,
  profile_id uuid not null references profiles (id) on delete cascade,
  granted_at timestamptz not null default now(),
  primary key (league_id, profile_id)
);

alter table league_commissioners enable row level security;

create policy "members read commissioners"
  on league_commissioners for select to authenticated
  using (is_league_member(league_id) or is_league_commissioner(league_id));

-- Extended to recognise co-commissioners. Every existing policy that calls
-- this picks the change up automatically.
create or replace function is_league_commissioner(p_league_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from leagues l
     where l.id = p_league_id and l.commissioner_id = auth.uid()
  ) or exists (
    select 1 from league_commissioners lc
     where lc.league_id = p_league_id and lc.profile_id = auth.uid()
  );
$$;

create or replace function is_league_owner(p_league_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from leagues
     where id = p_league_id and commissioner_id = auth.uid()
  );
$$;

-- ------------------------------------------------------ promote / demote ----

create or replace function set_commissioner(
  p_league_id uuid,
  p_profile_id uuid,
  p_grant boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid;
begin
  select commissioner_id into v_owner from leagues where id = p_league_id;

  if v_owner is null then
    raise exception 'League not found.';
  end if;

  if v_owner <> auth.uid() then
    raise exception 'Only the league owner can change commissioners.';
  end if;

  if p_profile_id = v_owner then
    raise exception 'The league owner is always a commissioner.';
  end if;

  if not exists (
    select 1 from fantasy_teams
     where league_id = p_league_id and owner_id = p_profile_id
  ) then
    raise exception 'That manager is not in this league.';
  end if;

  if p_grant then
    insert into league_commissioners (league_id, profile_id)
    values (p_league_id, p_profile_id)
    on conflict do nothing;
  else
    delete from league_commissioners
     where league_id = p_league_id and profile_id = p_profile_id;
  end if;
end;
$$;

-- ------------------------------------------------------------ remove team ----
-- Only before the draft. Afterwards their picks, results and fixtures are
-- woven through the season, and removing them would leave holes in everyone
-- else's schedule.

create or replace function remove_team(p_team_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_league_id uuid;
  v_owner_id  uuid;
  v_status    league_status;
begin
  select ft.league_id, ft.owner_id, l.status
    into v_league_id, v_owner_id, v_status
    from fantasy_teams ft
    join leagues l on l.id = ft.league_id
   where ft.id = p_team_id;

  if v_league_id is null then
    raise exception 'Team not found.';
  end if;

  if not is_league_commissioner(v_league_id) then
    raise exception 'Only a commissioner can remove a manager.';
  end if;

  if v_status <> 'setup' then
    raise exception
      'Managers can only be removed before the draft. Reset the league first if you need to.';
  end if;

  if exists (select 1 from leagues where id = v_league_id and commissioner_id = v_owner_id) then
    raise exception 'The league owner cannot be removed.';
  end if;

  delete from league_commissioners
   where league_id = v_league_id and profile_id = v_owner_id;

  delete from fantasy_teams where id = p_team_id;
end;
$$;

-- --------------------------------------------------------- reset league ----
-- Destructive and deliberate: everything the draft produced is deleted and the
-- league returns to setup. Requires the league's name as confirmation, so it
-- can't happen by misclick.

create or replace function reset_league(p_league_id uuid, p_confirm_name text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_league leagues%rowtype;
begin
  select * into v_league from leagues where id = p_league_id;

  if not found then
    raise exception 'League not found.';
  end if;

  if not is_league_commissioner(p_league_id) then
    raise exception 'Only a commissioner can reset the league.';
  end if;

  if btrim(coalesce(p_confirm_name, '')) <> v_league.name then
    raise exception 'Type the league name exactly to confirm.';
  end if;

  delete from lineup_players
   where lineup_id in (
     select l.id from lineups l
     join fantasy_teams t on t.id = l.fantasy_team_id
     where t.league_id = p_league_id
   );

  delete from lineups
   where fantasy_team_id in (select id from fantasy_teams where league_id = p_league_id);

  delete from trades                 where league_id = p_league_id;
  delete from player_gameweek_scores where league_id = p_league_id;
  delete from matchups               where league_id = p_league_id;
  delete from transactions           where league_id = p_league_id;
  delete from roster_entries         where league_id = p_league_id;
  delete from draft_picks            where league_id = p_league_id;

  update fantasy_teams set draft_position = null where league_id = p_league_id;

  update leagues
     set status = 'setup',
         roster_size = greatest(roster_size, min_gk + min_def + min_mid + min_fwd)
   where id = p_league_id;
end;
$$;

-- --------------------------------------------------------------- grants ----

revoke all on function set_commissioner(uuid, uuid, boolean) from public;
revoke all on function remove_team(uuid) from public;
revoke all on function reset_league(uuid, text) from public;
revoke all on function is_league_owner(uuid) from public;

grant execute on function set_commissioner(uuid, uuid, boolean) to authenticated;
grant execute on function remove_team(uuid) to authenticated;
grant execute on function reset_league(uuid, text) to authenticated;
grant execute on function is_league_owner(uuid) to authenticated;
