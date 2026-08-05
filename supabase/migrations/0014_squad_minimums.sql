-- 0014_squad_minimums.sql
-- Squad composition becomes minimums rather than exact quotas.
--
-- Default: 17 players, at least 2 GK / 3 DEF / 3 MID / 3 FWD. Those minimums
-- account for 11 places, leaving 6 to spend wherever you like.
--
-- This changes what has to be checked. Under exact quotas a per-position cap
-- was sufficient. Under minimums, drafting needs lookahead — a pick is only
-- legal if enough picks remain to still reach every minimum — while trades and
-- swaps simply have to leave both squads above the floor.

alter table leagues drop constraint if exists leagues_roster_size_matches_slots;
alter table leagues drop constraint if exists leagues_slots_positive;

alter table leagues rename column slots_gk  to min_gk;
alter table leagues rename column slots_def to min_def;
alter table leagues rename column slots_mid to min_mid;
alter table leagues rename column slots_fwd to min_fwd;

alter table leagues
  alter column min_gk  set default 2,
  alter column min_def set default 3,
  alter column min_mid set default 3,
  alter column min_fwd set default 3,
  alter column roster_size set default 17;

update leagues set min_gk = 2, min_def = 3, min_mid = 3, min_fwd = 3;
update leagues set roster_size = 17 where status = 'setup';

-- A squad must be able to field some legal formation: 1 GK, 3 DEF, 2 MID, 1 FWD
-- is the sparsest the formations table allows.
alter table leagues
  add constraint leagues_minimums_fieldable
  check (min_gk >= 1 and min_def >= 3 and min_mid >= 2 and min_fwd >= 1);

alter table leagues
  add constraint leagues_roster_size_fits_minimums
  check (roster_size >= min_gk + min_def + min_mid + min_fwd)
  not valid;

-- ------------------------------------------------------- minimums helper ----
-- Returns null when the resulting squad is legal, otherwise a description of
-- the first minimum it would break. Shared by swaps and trades so the rule
-- lives in exactly one place.

create or replace function squad_minimum_violation(
  p_team_id uuid,
  p_out     uuid[] default '{}',
  p_in      uuid[] default '{}'
)
returns text
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_league leagues%rowtype;
  v_gk  integer;
  v_def integer;
  v_mid integer;
  v_fwd integer;
begin
  select l.* into v_league
    from leagues l
    join fantasy_teams ft on ft.league_id = l.id
   where ft.id = p_team_id;

  select
    count(*) filter (where p.position = 'GK'),
    count(*) filter (where p.position = 'DEF'),
    count(*) filter (where p.position = 'MID'),
    count(*) filter (where p.position = 'FWD')
  into v_gk, v_def, v_mid, v_fwd
  from roster_entries re
  join players p on p.id = re.player_id
  where re.fantasy_team_id = p_team_id
    and re.dropped_at is null
    and not (re.player_id = any (coalesce(p_out, '{}')));

  select
    v_gk  + count(*) filter (where position = 'GK'),
    v_def + count(*) filter (where position = 'DEF'),
    v_mid + count(*) filter (where position = 'MID'),
    v_fwd + count(*) filter (where position = 'FWD')
  into v_gk, v_def, v_mid, v_fwd
  from players
  where id = any (coalesce(p_in, '{}'));

  if v_gk  < v_league.min_gk  then return format('%s goalkeepers',  v_league.min_gk);  end if;
  if v_def < v_league.min_def then return format('%s defenders',    v_league.min_def); end if;
  if v_mid < v_league.min_mid then return format('%s midfielders',  v_league.min_mid); end if;
  if v_fwd < v_league.min_fwd then return format('%s forwards',     v_league.min_fwd); end if;

  return null;
end;
$$;

-- ---------------------------------------------------- create league (upd) ----

drop function if exists create_league(text, text, integer, integer, integer, integer, integer);

create or replace function create_league(
  p_name        text,
  p_team_name   text,
  p_max_teams   integer default 10,
  p_roster_size integer default 17,
  p_min_gk      integer default 2,
  p_min_def     integer default 3,
  p_min_mid     integer default 3,
  p_min_fwd     integer default 3
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

  if p_roster_size < p_min_gk + p_min_def + p_min_mid + p_min_fwd then
    raise exception 'Roster size is too small for those minimums.';
  end if;

  insert into leagues (
    name, season_id, commissioner_id, max_teams,
    roster_size, min_gk, min_def, min_mid, min_fwd
  )
  values (
    trim(p_name), v_season_id, auth.uid(), p_max_teams,
    p_roster_size, p_min_gk, p_min_def, p_min_mid, p_min_fwd
  )
  returning id into v_league_id;

  insert into fantasy_teams (league_id, owner_id, name)
  values (v_league_id, auth.uid(), trim(p_team_name));

  return v_league_id;
end;
$$;

revoke all on function create_league(text, text, integer, integer, integer, integer, integer, integer) from public;
grant execute on function create_league(text, text, integer, integer, integer, integer, integer, integer) to authenticated;

-- -------------------------------------------------------- make pick (upd) ----

create or replace function make_pick(p_league_id uuid, p_player_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_team_id   uuid;
  v_pick      draft_picks%rowtype;
  v_league    leagues%rowtype;
  v_position  player_position;
  v_gk        integer;
  v_def       integer;
  v_mid       integer;
  v_fwd       integer;
  v_remaining integer;
  v_shortfall integer;
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
     where league_id = p_league_id and player_id = p_player_id and dropped_at is null
  ) then
    raise exception 'That player has already been drafted.';
  end if;

  select
    count(*) filter (where p.position = 'GK'),
    count(*) filter (where p.position = 'DEF'),
    count(*) filter (where p.position = 'MID'),
    count(*) filter (where p.position = 'FWD')
  into v_gk, v_def, v_mid, v_fwd
  from roster_entries re
  join players p on p.id = re.player_id
  where re.fantasy_team_id = v_team_id and re.dropped_at is null;

  -- Count this pick, then ask whether the remaining picks can still cover
  -- every minimum. This is what replaces the old per-position cap.
  v_gk  := v_gk  + (v_position = 'GK')::integer;
  v_def := v_def + (v_position = 'DEF')::integer;
  v_mid := v_mid + (v_position = 'MID')::integer;
  v_fwd := v_fwd + (v_position = 'FWD')::integer;

  v_remaining := v_league.roster_size - (v_gk + v_def + v_mid + v_fwd);

  v_shortfall := greatest(0, v_league.min_gk  - v_gk)
               + greatest(0, v_league.min_def - v_def)
               + greatest(0, v_league.min_mid - v_mid)
               + greatest(0, v_league.min_fwd - v_fwd);

  if v_shortfall > v_remaining then
    raise exception
      'Another % would leave you short: % more players needed to meet the minimums, but only % picks left.',
      v_position, v_shortfall, v_remaining;
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
    perform generate_schedule(p_league_id);
  end if;

  return v_pick.overall_pick;
end;
$$;

revoke all on function make_pick(uuid, uuid) from public;
grant execute on function make_pick(uuid, uuid) to authenticated;

-- ------------------------------------------------------ swap player (upd) ----
-- Swaps no longer have to be like for like: any player may replace any other,
-- so long as the squad still meets its minimums afterwards.

create or replace function swap_player(
  p_league_id      uuid,
  p_drop_player_id uuid,
  p_add_player_id  uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_team_id   uuid;
  v_status    league_status;
  v_entry_id  uuid;
  v_violation text;
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

  if p_drop_player_id = p_add_player_id then
    raise exception 'Pick a different player to add.';
  end if;

  select id into v_entry_id
    from roster_entries
   where fantasy_team_id = v_team_id
     and player_id = p_drop_player_id
     and dropped_at is null
   for update;

  if v_entry_id is null then
    raise exception 'That player is not on your roster.';
  end if;

  if not exists (select 1 from players where id = p_add_player_id and is_active) then
    raise exception 'That player is not available.';
  end if;

  if exists (
    select 1 from roster_entries
     where league_id = p_league_id and player_id = p_add_player_id and dropped_at is null
  ) then
    raise exception 'That player is already on a roster in this league.';
  end if;

  v_violation := squad_minimum_violation(
    v_team_id, array[p_drop_player_id], array[p_add_player_id]
  );

  if v_violation is not null then
    raise exception 'That swap would leave you below the minimum of %.', v_violation;
  end if;

  update roster_entries set dropped_at = now() where id = v_entry_id;

  insert into roster_entries (league_id, fantasy_team_id, player_id, acquired_via)
  values (p_league_id, v_team_id, p_add_player_id, 'free_agent');

  insert into transactions (
    league_id, fantasy_team_id, type, player_in_id, player_out_id, created_by
  )
  values (p_league_id, v_team_id, 'add', p_add_player_id, p_drop_player_id, auth.uid());

  delete from lineups
   where id in (
     select l.id
       from lineups l
       join gameweeks g on g.id = l.gameweek_id
       join lineup_players lp on lp.lineup_id = l.id
      where l.fantasy_team_id = v_team_id
        and g.deadline_at > now()
        and lp.player_id = p_drop_player_id
   );

  return v_team_id;
end;
$$;

revoke all on function swap_player(uuid, uuid, uuid) from public;
grant execute on function swap_player(uuid, uuid, uuid) to authenticated;

-- --------------------------------------------------- propose trade (upd) ----
-- Positions no longer have to match. Both sides must trade the same number of
-- players — squads stay at roster_size — and both must still meet minimums.

create or replace function propose_trade(
  p_league_id        uuid,
  p_receiver_team_id uuid,
  p_offer_ids        uuid[],
  p_request_ids      uuid[],
  p_note             text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_proposer  uuid;
  v_status    league_status;
  v_trade_id  uuid;
  v_count     integer;
  v_violation text;
begin
  select status into v_status from leagues where id = p_league_id;

  if v_status is null then
    raise exception 'League not found.';
  end if;

  if v_status <> 'active' then
    raise exception 'Trades are only allowed once the draft is complete.';
  end if;

  select id into v_proposer
    from fantasy_teams
   where league_id = p_league_id and owner_id = auth.uid();

  if v_proposer is null then
    raise exception 'You do not have a team in this league.';
  end if;

  if v_proposer = p_receiver_team_id then
    raise exception 'You cannot trade with yourself.';
  end if;

  if not exists (
    select 1 from fantasy_teams where id = p_receiver_team_id and league_id = p_league_id
  ) then
    raise exception 'That team is not in this league.';
  end if;

  if coalesce(array_length(p_offer_ids, 1), 0) = 0
     or coalesce(array_length(p_request_ids, 1), 0) = 0 then
    raise exception 'A trade needs players on both sides.';
  end if;

  if array_length(p_offer_ids, 1) <> array_length(p_request_ids, 1) then
    raise exception 'Both sides must trade the same number of players.';
  end if;

  select count(*) into v_count
    from roster_entries
   where fantasy_team_id = v_proposer
     and dropped_at is null
     and player_id = any (p_offer_ids);

  if v_count <> array_length(p_offer_ids, 1) then
    raise exception 'You can only offer players on your own roster.';
  end if;

  select count(*) into v_count
    from roster_entries
   where fantasy_team_id = p_receiver_team_id
     and dropped_at is null
     and player_id = any (p_request_ids);

  if v_count <> array_length(p_request_ids, 1) then
    raise exception 'You can only request players on their roster.';
  end if;

  v_violation := squad_minimum_violation(v_proposer, p_offer_ids, p_request_ids);
  if v_violation is not null then
    raise exception 'That trade would leave you below the minimum of %.', v_violation;
  end if;

  v_violation := squad_minimum_violation(p_receiver_team_id, p_request_ids, p_offer_ids);
  if v_violation is not null then
    raise exception 'That trade would leave them below the minimum of %.', v_violation;
  end if;

  insert into trades (league_id, proposer_team_id, receiver_team_id, note)
  values (p_league_id, v_proposer, p_receiver_team_id, nullif(trim(p_note), ''))
  returning id into v_trade_id;

  insert into trade_items (trade_id, player_id, from_team_id)
  select v_trade_id, player_id, v_proposer from unnest(p_offer_ids) as o (player_id)
   union all
  select v_trade_id, player_id, p_receiver_team_id from unnest(p_request_ids) as r (player_id);

  return v_trade_id;
end;
$$;

revoke all on function propose_trade(uuid, uuid, uuid[], uuid[], text) from public;
grant execute on function propose_trade(uuid, uuid, uuid[], uuid[], text) to authenticated;

-- -------------------------------------------------- execute trade (upd) ----
-- Re-checks minimums at execution: rosters can change during the veto window,
-- so a trade that was legal when accepted may not be legal a day later.

create or replace function execute_trade(p_trade_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_trade     trades%rowtype;
  v_item      record;
  v_to        uuid;
  v_offer     uuid[];
  v_request   uuid[];
  v_violation text;
begin
  select * into v_trade from trades where id = p_trade_id for update;

  if v_trade.status <> 'accepted' then
    return;
  end if;

  select array_agg(player_id) filter (where from_team_id = v_trade.proposer_team_id),
         array_agg(player_id) filter (where from_team_id = v_trade.receiver_team_id)
    into v_offer, v_request
    from trade_items where trade_id = p_trade_id;

  v_violation := coalesce(
    squad_minimum_violation(v_trade.proposer_team_id, v_offer, v_request),
    squad_minimum_violation(v_trade.receiver_team_id, v_request, v_offer)
  );

  if v_violation is not null then
    update trades
       set status = 'cancelled',
           resolved_at = now(),
           note = concat_ws(
             ' ', note,
             format('[auto-cancelled: squad would fall below %s]', v_violation)
           )
     where id = p_trade_id;
    return;
  end if;

  for v_item in select * from trade_items where trade_id = p_trade_id loop
    v_to := case
              when v_item.from_team_id = v_trade.proposer_team_id
              then v_trade.receiver_team_id
              else v_trade.proposer_team_id
            end;

    update roster_entries
       set dropped_at = now()
     where fantasy_team_id = v_item.from_team_id
       and player_id = v_item.player_id
       and dropped_at is null;

    insert into roster_entries (league_id, fantasy_team_id, player_id, acquired_via)
    values (v_trade.league_id, v_to, v_item.player_id, 'trade');

    insert into transactions (
      league_id, fantasy_team_id, type, player_in_id, counterparty_team_id
    )
    values (v_trade.league_id, v_to, 'trade', v_item.player_id, v_item.from_team_id);
  end loop;

  delete from lineups
   where id in (
     select l.id
       from lineups l
       join gameweeks g on g.id = l.gameweek_id
       join lineup_players lp on lp.lineup_id = l.id
      where l.fantasy_team_id in (v_trade.proposer_team_id, v_trade.receiver_team_id)
        and g.deadline_at > now()
        and lp.player_id in (select player_id from trade_items where trade_id = p_trade_id)
   );

  update trades set status = 'executed', resolved_at = now() where id = p_trade_id;
end;
$$;

revoke all on function execute_trade(uuid) from public;
revoke all on function squad_minimum_violation(uuid, uuid[], uuid[]) from public;
grant execute on function squad_minimum_violation(uuid, uuid[], uuid[]) to authenticated;
