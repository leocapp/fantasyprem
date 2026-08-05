-- 0013_trades.sql
-- Manager-to-manager trades with a league veto period.
--
-- Lifecycle:
--   proposed  -> rejected | cancelled
--             -> accepted -> vetoed
--                         -> executed (once the veto window closes)
--
-- Position counts must balance on both sides, which keeps every squad at its
-- quotas and means a legal XI stays fieldable without further checks.
--
-- There is no scheduler in this stack, so accepted trades execute lazily:
-- execute_due_trades() runs when someone loads a league page. Worst case a
-- trade settles late, never early, and never without the window elapsing.

create type trade_status as enum (
  'proposed', 'rejected', 'cancelled', 'accepted', 'vetoed', 'executed'
);

create table trades (
  id               uuid primary key default gen_random_uuid(),
  league_id        uuid not null references leagues (id) on delete cascade,
  proposer_team_id uuid not null references fantasy_teams (id) on delete cascade,
  receiver_team_id uuid not null references fantasy_teams (id) on delete cascade,
  status           trade_status not null default 'proposed',
  note             text,
  created_at       timestamptz not null default now(),
  responded_at     timestamptz,
  veto_deadline    timestamptz,
  resolved_at      timestamptz,
  check (proposer_team_id <> receiver_team_id)
);

create index trades_league_idx on trades (league_id, created_at desc);

create table trade_items (
  id           uuid primary key default gen_random_uuid(),
  trade_id     uuid not null references trades (id) on delete cascade,
  player_id    uuid not null references players (id) on delete cascade,
  from_team_id uuid not null references fantasy_teams (id) on delete cascade,
  unique (trade_id, player_id)
);

create table trade_vetoes (
  id              uuid primary key default gen_random_uuid(),
  trade_id        uuid not null references trades (id) on delete cascade,
  fantasy_team_id uuid not null references fantasy_teams (id) on delete cascade,
  created_at      timestamptz not null default now(),
  unique (trade_id, fantasy_team_id)
);

-- ------------------------------------------------------------------- rls ----

alter table trades       enable row level security;
alter table trade_items  enable row level security;
alter table trade_vetoes enable row level security;

create policy "members read trades"
  on trades for select to authenticated
  using (is_league_member(league_id) or is_league_commissioner(league_id));

create policy "members read trade items"
  on trade_items for select to authenticated
  using (
    exists (
      select 1 from trades t
       where t.id = trade_items.trade_id and is_league_member(t.league_id)
    )
  );

create policy "members read trade vetoes"
  on trade_vetoes for select to authenticated
  using (
    exists (
      select 1 from trades t
       where t.id = trade_vetoes.trade_id and is_league_member(t.league_id)
    )
  );

-- --------------------------------------------------------- veto threshold ----
-- Majority of managers who are not part of the trade. Null when nobody else is
-- in the league, in which case the trade cannot be vetoed at all.

create or replace function trade_veto_threshold(p_trade_id uuid)
returns integer
language sql
security definer
stable
set search_path = public
as $$
  select case when count(*) = 0 then null else (count(*) / 2) + 1 end
    from fantasy_teams ft
    join trades t on t.id = p_trade_id
   where ft.league_id = t.league_id
     and ft.id <> t.proposer_team_id
     and ft.id <> t.receiver_team_id;
$$;

-- ---------------------------------------------------------- propose trade ----

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
  v_proposer uuid;
  v_status   league_status;
  v_trade_id uuid;
  v_count    integer;
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
    select 1 from fantasy_teams
     where id = p_receiver_team_id and league_id = p_league_id
  ) then
    raise exception 'That team is not in this league.';
  end if;

  if coalesce(array_length(p_offer_ids, 1), 0) = 0
     or coalesce(array_length(p_request_ids, 1), 0) = 0 then
    raise exception 'A trade needs players on both sides.';
  end if;

  -- Everything offered must currently belong to the proposer.
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

  -- Position counts must match, so both squads keep their quotas.
  if exists (
    select 1
      from (
        select position, count(*) as n from players where id = any (p_offer_ids) group by position
      ) offered
      full outer join (
        select position, count(*) as n from players where id = any (p_request_ids) group by position
      ) requested using (position)
     where coalesce(offered.n, 0) <> coalesce(requested.n, 0)
  ) then
    raise exception
      'Both sides must give up the same number of players in each position.';
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

-- -------------------------------------------------------- respond / cancel ----

create or replace function respond_to_trade(p_trade_id uuid, p_accept boolean)
returns trade_status
language plpgsql
security definer
set search_path = public
as $$
declare
  v_trade trades%rowtype;
begin
  select * into v_trade from trades where id = p_trade_id for update;

  if not found then
    raise exception 'Trade not found.';
  end if;

  if v_trade.status <> 'proposed' then
    raise exception 'This trade is no longer open.';
  end if;

  if not exists (
    select 1 from fantasy_teams
     where id = v_trade.receiver_team_id and owner_id = auth.uid()
  ) then
    raise exception 'Only the receiving manager can respond.';
  end if;

  if not p_accept then
    update trades
       set status = 'rejected', responded_at = now(), resolved_at = now()
     where id = p_trade_id;
    return 'rejected';
  end if;

  update trades
     set status = 'accepted',
         responded_at = now(),
         veto_deadline = now() + interval '24 hours'
   where id = p_trade_id;

  -- Nobody else in the league means nobody can veto: settle it now.
  if trade_veto_threshold(p_trade_id) is null then
    perform execute_trade(p_trade_id);
    return 'executed';
  end if;

  return 'accepted';
end;
$$;

create or replace function cancel_trade(p_trade_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_trade trades%rowtype;
begin
  select * into v_trade from trades where id = p_trade_id;

  if not found then
    raise exception 'Trade not found.';
  end if;

  if v_trade.status <> 'proposed' then
    raise exception 'Only an open proposal can be withdrawn.';
  end if;

  if not exists (
    select 1 from fantasy_teams
     where id = v_trade.proposer_team_id and owner_id = auth.uid()
  ) then
    raise exception 'Only the proposing manager can withdraw it.';
  end if;

  update trades set status = 'cancelled', resolved_at = now() where id = p_trade_id;
end;
$$;

-- ---------------------------------------------------------------- veto ----

create or replace function veto_trade(p_trade_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_trade     trades%rowtype;
  v_team_id   uuid;
  v_votes     integer;
  v_threshold integer;
begin
  select * into v_trade from trades where id = p_trade_id for update;

  if not found then
    raise exception 'Trade not found.';
  end if;

  if v_trade.status <> 'accepted' then
    raise exception 'Only an accepted trade can be vetoed.';
  end if;

  if v_trade.veto_deadline <= now() then
    raise exception 'The veto window has closed.';
  end if;

  select id into v_team_id
    from fantasy_teams
   where league_id = v_trade.league_id and owner_id = auth.uid();

  if v_team_id is null then
    raise exception 'You do not have a team in this league.';
  end if;

  if v_team_id in (v_trade.proposer_team_id, v_trade.receiver_team_id) then
    raise exception 'Managers involved in a trade cannot veto it.';
  end if;

  insert into trade_vetoes (trade_id, fantasy_team_id)
  values (p_trade_id, v_team_id)
  on conflict (trade_id, fantasy_team_id) do nothing;

  select count(*) into v_votes from trade_vetoes where trade_id = p_trade_id;
  v_threshold := trade_veto_threshold(p_trade_id);

  if v_threshold is not null and v_votes >= v_threshold then
    update trades set status = 'vetoed', resolved_at = now() where id = p_trade_id;
  end if;

  return v_votes;
end;
$$;

-- ------------------------------------------------------------- execution ----

create or replace function execute_trade(p_trade_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_trade trades%rowtype;
  v_item  record;
  v_to    uuid;
begin
  select * into v_trade from trades where id = p_trade_id for update;

  if v_trade.status <> 'accepted' then
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

  -- Lineups naming a traded player are now illegal; clear the unlocked ones so
  -- managers re-pick rather than silently fielding fewer than eleven.
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

create or replace function execute_due_trades(p_league_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_trade record;
  v_done  integer := 0;
begin
  for v_trade in
    select id from trades
     where league_id = p_league_id
       and status = 'accepted'
       and veto_deadline <= now()
  loop
    perform execute_trade(v_trade.id);
    v_done := v_done + 1;
  end loop;

  return v_done;
end;
$$;

-- --------------------------------------------------------------- grants ----

revoke all on function propose_trade(uuid, uuid, uuid[], uuid[], text) from public;
revoke all on function respond_to_trade(uuid, boolean) from public;
revoke all on function cancel_trade(uuid) from public;
revoke all on function veto_trade(uuid) from public;
revoke all on function execute_trade(uuid) from public;
revoke all on function execute_due_trades(uuid) from public;
revoke all on function trade_veto_threshold(uuid) from public;

grant execute on function propose_trade(uuid, uuid, uuid[], uuid[], text) to authenticated;
grant execute on function respond_to_trade(uuid, boolean) to authenticated;
grant execute on function cancel_trade(uuid) to authenticated;
grant execute on function veto_trade(uuid) to authenticated;
grant execute on function execute_due_trades(uuid) to authenticated;
grant execute on function trade_veto_threshold(uuid) to authenticated;
