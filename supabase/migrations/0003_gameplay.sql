-- 0003_gameplay.sql
-- Weekly play: lineups, head-to-head matchups, computed points, transactions.

-- ---------------------------------------------------------------- enums ----

create type lineup_role as enum ('starter', 'bench');
create type matchup_status as enum ('scheduled', 'live', 'final');
create type transaction_type as enum ('draft', 'add', 'drop', 'trade');

-- ------------------------------------------------------------- lineups ----
-- One lineup per team per gameweek, locked at the gameweek deadline.

create table lineups (
  id              uuid primary key default gen_random_uuid(),
  fantasy_team_id uuid not null references fantasy_teams (id) on delete cascade,
  gameweek_id     uuid not null references gameweeks (id) on delete cascade,
  formation       text not null default '4-4-2'
                  check (formation ~ '^\d-\d-\d$'),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (fantasy_team_id, gameweek_id)
);

create trigger lineups_set_updated_at
  before update on lineups
  for each row execute function set_updated_at();

create table lineup_players (
  id             uuid primary key default gen_random_uuid(),
  lineup_id      uuid not null references lineups (id) on delete cascade,
  player_id      uuid not null references players (id) on delete cascade,
  role           lineup_role not null,
  bench_order    integer,                     -- 1 = first sub on
  is_captain     boolean not null default false,
  is_vice_captain boolean not null default false,
  unique (lineup_id, player_id),
  check (role = 'bench' or bench_order is null),
  check (not (is_captain and is_vice_captain))
);

create unique index lineup_players_one_captain
  on lineup_players (lineup_id) where is_captain;

create unique index lineup_players_one_vice
  on lineup_players (lineup_id) where is_vice_captain;

create unique index lineup_players_bench_order
  on lineup_players (lineup_id, bench_order)
  where bench_order is not null;

-- Formation validity (1 GK, 3+ DEF, and so on) depends on the league's
-- settings, so it is enforced in the API rather than by a constraint here.

-- ------------------------------------------------------------ matchups ----
-- Head-to-head schedule. away_team_id is null for a bye week (odd team count).

create table matchups (
  id           uuid primary key default gen_random_uuid(),
  league_id    uuid not null references leagues (id) on delete cascade,
  gameweek_id  uuid not null references gameweeks (id) on delete cascade,
  home_team_id uuid not null references fantasy_teams (id) on delete cascade,
  away_team_id uuid references fantasy_teams (id) on delete cascade,
  home_points  numeric(7, 2) not null default 0,
  away_points  numeric(7, 2) not null default 0,
  status       matchup_status not null default 'scheduled',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  check (away_team_id is null or home_team_id <> away_team_id)
);

-- A team can hold each side of a gameweek only once. (Preventing the same team
-- from being home in one matchup and away in another is left to the schedule
-- generator, which builds the whole gameweek at once.)
create unique index matchups_home_slot on matchups (league_id, gameweek_id, home_team_id);
create unique index matchups_away_slot
  on matchups (league_id, gameweek_id, away_team_id)
  where away_team_id is not null;

create trigger matchups_set_updated_at
  before update on matchups
  for each row execute function set_updated_at();

-- ------------------------------------------- computed player gameweek ----
-- Cache of scoring-engine output. Keyed by league because scoring rules are
-- per league; `breakdown` keeps the per-stat detail for the UI.

create table player_gameweek_scores (
  id          uuid primary key default gen_random_uuid(),
  league_id   uuid not null references leagues (id) on delete cascade,
  player_id   uuid not null references players (id) on delete cascade,
  gameweek_id uuid not null references gameweeks (id) on delete cascade,
  points      numeric(6, 2) not null default 0,
  breakdown   jsonb not null default '{}'::jsonb,
  computed_at timestamptz not null default now(),
  unique (league_id, player_id, gameweek_id)
);

create index player_gameweek_scores_lookup
  on player_gameweek_scores (league_id, gameweek_id);

-- -------------------------------------------------------- transactions ----
-- Audit log of roster movement.

create table transactions (
  id              uuid primary key default gen_random_uuid(),
  league_id       uuid not null references leagues (id) on delete cascade,
  fantasy_team_id uuid not null references fantasy_teams (id) on delete cascade,
  type            transaction_type not null,
  player_in_id    uuid references players (id) on delete set null,
  player_out_id   uuid references players (id) on delete set null,
  counterparty_team_id uuid references fantasy_teams (id) on delete set null,
  created_by      uuid references profiles (id) on delete set null,
  created_at      timestamptz not null default now()
);

create index transactions_league_idx on transactions (league_id, created_at desc);

-- ----------------------------------------------------------- standings ----
-- Derived from final matchups; no table to keep in sync.

create view league_standings as
with results as (
  select league_id, home_team_id as team_id, home_points as points_for,
         away_points as points_against, status
    from matchups
   union all
  select league_id, away_team_id, away_points, home_points, status
    from matchups
   where away_team_id is not null
)
select
  league_id,
  team_id,
  count(*) filter (where status = 'final')                          as games_played,
  count(*) filter (where status = 'final' and points_for > points_against) as wins,
  count(*) filter (where status = 'final' and points_for < points_against) as losses,
  count(*) filter (where status = 'final' and points_for = points_against) as draws,
  coalesce(sum(points_for) filter (where status = 'final'), 0)      as points_for,
  coalesce(sum(points_against) filter (where status = 'final'), 0)  as points_against
from results
group by league_id, team_id;
