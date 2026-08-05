-- 0005_league_functions.sql
-- Creating and joining leagues.
--
-- Both operations need to break out of RLS, for different reasons:
--
--   create_league  writes two tables atomically (a league plus the
--                  commissioner's own team), and the league must exist before
--                  the membership that authorises reading it does.
--   join_league    looks up a league by join code — but the RLS policy on
--                  `leagues` only lets you see leagues you already belong to,
--                  so a would-be member could never find it.
--
-- Both are SECURITY DEFINER and validate auth.uid() themselves.

-- ------------------------------------------------------ current season ----
-- Placeholder so leagues can be created before the ingestion job exists.
-- Correct these dates when real fixture data lands.

insert into seasons (label, starts_on, ends_on, is_current)
values ('2026/27', '2026-08-15', '2027-05-23', true)
on conflict (label) do nothing;

-- -------------------------------------------------------- create league ----

create or replace function create_league(
  p_name        text,
  p_team_name   text,
  p_max_teams   integer default 10,
  p_roster_size integer default 15
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

  insert into leagues (name, season_id, commissioner_id, max_teams, roster_size)
  values (trim(p_name), v_season_id, auth.uid(), p_max_teams, p_roster_size)
  returning id into v_league_id;

  insert into fantasy_teams (league_id, owner_id, name)
  values (v_league_id, auth.uid(), trim(p_team_name));

  return v_league_id;
end;
$$;

-- ---------------------------------------------------------- join league ----

create or replace function join_league(
  p_join_code text,
  p_team_name text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_league leagues%rowtype;
  v_teams  integer;
begin
  if auth.uid() is null then
    raise exception 'You must be signed in to join a league.';
  end if;

  select * into v_league
    from leagues
   where join_code = upper(trim(p_join_code));

  if not found then
    raise exception 'No league found with that code.';
  end if;

  if v_league.status <> 'setup' then
    raise exception 'That league has already started.';
  end if;

  if exists (
    select 1 from fantasy_teams
     where league_id = v_league.id and owner_id = auth.uid()
  ) then
    raise exception 'You are already in that league.';
  end if;

  select count(*) into v_teams from fantasy_teams where league_id = v_league.id;
  if v_teams >= v_league.max_teams then
    raise exception 'That league is full.';
  end if;

  insert into fantasy_teams (league_id, owner_id, name)
  values (v_league.id, auth.uid(), trim(p_team_name));

  return v_league.id;
end;
$$;

-- ---------------------------------------------------------------- grants ----

revoke all on function create_league(text, text, integer, integer) from public;
revoke all on function join_league(text, text) from public;

grant execute on function create_league(text, text, integer, integer) to authenticated;
grant execute on function join_league(text, text) to authenticated;
