-- 0001_reference_data.sql
-- Real-world football data: seasons, clubs, gameweeks, players, fixtures, stats.
-- This data is global (shared by every league) and is written by the ingestion
-- job using the service role key, never by end users.

-- ---------------------------------------------------------------- enums ----

create type player_position as enum ('GK', 'DEF', 'MID', 'FWD');
create type gameweek_status as enum ('upcoming', 'active', 'complete');
create type fixture_status as enum ('scheduled', 'live', 'finished', 'postponed');

-- ------------------------------------------------------------- helpers ----

create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ------------------------------------------------------------- seasons ----

create table seasons (
  id          uuid primary key default gen_random_uuid(),
  label       text not null unique,              -- e.g. '2025/26'
  starts_on   date not null,
  ends_on     date not null,
  is_current  boolean not null default false,
  created_at  timestamptz not null default now(),
  check (ends_on > starts_on)
);

-- At most one current season.
create unique index seasons_one_current on seasons (is_current) where is_current;

-- --------------------------------------------------------------- clubs ----

create table clubs (
  id          uuid primary key default gen_random_uuid(),
  external_id text unique,                        -- id from the stats provider
  name        text not null,
  short_name  text not null,                      -- 'ARS', 'MCI'
  crest_url   text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create trigger clubs_set_updated_at
  before update on clubs
  for each row execute function set_updated_at();

-- ----------------------------------------------------------- gameweeks ----

create table gameweeks (
  id          uuid primary key default gen_random_uuid(),
  season_id   uuid not null references seasons (id) on delete cascade,
  number      integer not null check (number between 1 and 60),
  deadline_at timestamptz not null,               -- lineups lock here
  status      gameweek_status not null default 'upcoming',
  created_at  timestamptz not null default now(),
  unique (season_id, number)
);

-- ------------------------------------------------------------- players ----

create table players (
  id            uuid primary key default gen_random_uuid(),
  external_id   text unique,
  first_name    text,
  last_name     text not null,
  display_name  text not null,
  position      player_position not null,
  club_id       uuid references clubs (id) on delete set null,
  shirt_number  integer,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index players_club_idx on players (club_id);
create index players_position_idx on players (position);

create trigger players_set_updated_at
  before update on players
  for each row execute function set_updated_at();

-- ------------------------------------------------------------ fixtures ----

create table fixtures (
  id            uuid primary key default gen_random_uuid(),
  external_id   text unique,
  season_id     uuid not null references seasons (id) on delete cascade,
  gameweek_id   uuid not null references gameweeks (id) on delete cascade,
  home_club_id  uuid not null references clubs (id) on delete restrict,
  away_club_id  uuid not null references clubs (id) on delete restrict,
  kickoff_at    timestamptz not null,
  status        fixture_status not null default 'scheduled',
  home_score    integer,
  away_score    integer,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  check (home_club_id <> away_club_id)
);

create index fixtures_gameweek_idx on fixtures (gameweek_id);
create index fixtures_kickoff_idx on fixtures (kickoff_at);

create trigger fixtures_set_updated_at
  before update on fixtures
  for each row execute function set_updated_at();

-- -------------------------------------------------- player match stats ----
-- Raw per-match performance. Fantasy points are NOT stored here: each league
-- has its own scoring rules, so points are derived per league (see 0003).

create table player_match_stats (
  id                uuid primary key default gen_random_uuid(),
  fixture_id        uuid not null references fixtures (id) on delete cascade,
  player_id         uuid not null references players (id) on delete cascade,
  club_id           uuid references clubs (id) on delete set null,
  minutes           integer not null default 0,
  goals             integer not null default 0,
  assists           integer not null default 0,
  clean_sheet       boolean not null default false,
  goals_conceded    integer not null default 0,
  own_goals         integer not null default 0,
  penalties_scored  integer not null default 0,
  penalties_missed  integer not null default 0,
  penalties_saved   integer not null default 0,
  saves             integer not null default 0,
  yellow_cards      integer not null default 0,
  red_cards         integer not null default 0,
  bonus             integer not null default 0,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (fixture_id, player_id)
);

create index player_match_stats_player_idx on player_match_stats (player_id);

create trigger player_match_stats_set_updated_at
  before update on player_match_stats
  for each row execute function set_updated_at();
