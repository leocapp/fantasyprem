-- 0002_leagues_and_draft.sql
-- User-owned data: profiles, leagues, fantasy teams, scoring rules, the draft,
-- and player ownership.

-- ---------------------------------------------------------------- enums ----

create type league_status as enum ('setup', 'drafting', 'active', 'complete');
create type acquisition_type as enum ('draft', 'waiver', 'free_agent', 'trade');

-- ------------------------------------------------------------ profiles ----
-- One row per auth user. Supabase owns auth.users; this is the public-facing
-- mirror we can safely join against.

create table profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  username     text unique check (char_length(username) between 3 and 30),
  display_name text,
  avatar_url   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create trigger profiles_set_updated_at
  before update on profiles
  for each row execute function set_updated_at();

-- Auto-create a profile whenever someone signs up.
create or replace function handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1)))
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ------------------------------------------------------------- leagues ----

create table leagues (
  id              uuid primary key default gen_random_uuid(),
  name            text not null check (char_length(name) between 3 and 60),
  season_id       uuid not null references seasons (id) on delete restrict,
  commissioner_id uuid not null references profiles (id) on delete restrict,
  join_code       text not null unique default upper(substr(md5(random()::text), 1, 6)),
  status          league_status not null default 'setup',
  max_teams       integer not null default 10 check (max_teams between 2 and 20),
  roster_size     integer not null default 15 check (roster_size between 11 and 30),
  starters_count  integer not null default 11,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index leagues_commissioner_idx on leagues (commissioner_id);

create trigger leagues_set_updated_at
  before update on leagues
  for each row execute function set_updated_at();

-- ------------------------------------------------------- fantasy teams ----
-- A team is also the membership record: one team per user per league.

create table fantasy_teams (
  id            uuid primary key default gen_random_uuid(),
  league_id     uuid not null references leagues (id) on delete cascade,
  owner_id      uuid not null references profiles (id) on delete cascade,
  name          text not null check (char_length(name) between 2 and 40),
  draft_position integer,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (league_id, owner_id),
  unique (league_id, name)
);

create unique index fantasy_teams_draft_slot
  on fantasy_teams (league_id, draft_position)
  where draft_position is not null;

create index fantasy_teams_owner_idx on fantasy_teams (owner_id);

create trigger fantasy_teams_set_updated_at
  before update on fantasy_teams
  for each row execute function set_updated_at();

-- ------------------------------------------------------- scoring rules ----
-- stat_key matches a column on player_match_stats. A null `applies_to` means
-- the rule covers every position.

create table default_scoring_rules (
  stat_key   text not null,
  applies_to player_position,
  points     numeric(5, 2) not null
);

-- Split in two because a NULL applies_to means "all positions", and NULLs are
-- never equal to each other in a plain unique index. (Casting the enum to text
-- inside one expression index is not allowed: that cast is STABLE, not
-- IMMUTABLE.)
create unique index default_scoring_rules_by_position
  on default_scoring_rules (stat_key, applies_to)
  where applies_to is not null;

create unique index default_scoring_rules_all_positions
  on default_scoring_rules (stat_key)
  where applies_to is null;

insert into default_scoring_rules (stat_key, applies_to, points) values
  ('minutes_played',    null,  1),    -- awarded for 1-59 minutes
  ('minutes_full',      null,  2),    -- awarded for 60+ minutes
  ('goals',            'GK',   6),
  ('goals',            'DEF',  6),
  ('goals',            'MID',  5),
  ('goals',            'FWD',  4),
  ('assists',           null,  3),
  ('clean_sheet',      'GK',   4),
  ('clean_sheet',      'DEF',  4),
  ('clean_sheet',      'MID',  1),
  ('goals_conceded_2', 'GK',  -1),    -- per 2 conceded
  ('goals_conceded_2', 'DEF', -1),
  ('saves_3',          'GK',   1),    -- per 3 saves
  ('penalties_saved',  'GK',   5),
  ('penalties_missed',  null, -2),
  ('own_goals',         null, -2),
  ('yellow_cards',      null, -1),
  ('red_cards',         null, -3),
  ('bonus',             null,  1);

create table scoring_rules (
  id         uuid primary key default gen_random_uuid(),
  league_id  uuid not null references leagues (id) on delete cascade,
  stat_key   text not null,
  applies_to player_position,
  points     numeric(5, 2) not null
);

create unique index scoring_rules_by_position
  on scoring_rules (league_id, stat_key, applies_to)
  where applies_to is not null;

create unique index scoring_rules_all_positions
  on scoring_rules (league_id, stat_key)
  where applies_to is null;

-- Every new league starts from the defaults; commissioners can edit after.
create or replace function seed_league_scoring_rules()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.scoring_rules (league_id, stat_key, applies_to, points)
  select new.id, stat_key, applies_to, points from public.default_scoring_rules;
  return new;
end;
$$;

create trigger leagues_seed_scoring_rules
  after insert on leagues
  for each row execute function seed_league_scoring_rules();

-- --------------------------------------------------------- draft picks ----
-- Snake order is generated up front, then filled in as picks are made.

create table draft_picks (
  id              uuid primary key default gen_random_uuid(),
  league_id       uuid not null references leagues (id) on delete cascade,
  round           integer not null check (round > 0),
  pick_in_round   integer not null check (pick_in_round > 0),
  overall_pick    integer not null check (overall_pick > 0),
  fantasy_team_id uuid not null references fantasy_teams (id) on delete cascade,
  player_id       uuid references players (id) on delete set null,
  picked_at       timestamptz,
  unique (league_id, overall_pick),
  unique (league_id, round, pick_in_round)
);

-- A player can only be drafted once per league.
create unique index draft_picks_one_per_player
  on draft_picks (league_id, player_id)
  where player_id is not null;

create index draft_picks_team_idx on draft_picks (fantasy_team_id);

-- ------------------------------------------------------ roster entries ----
-- Ownership over time. A row with dropped_at = null is a current holding;
-- the partial unique index is what enforces exclusive ownership per league.

create table roster_entries (
  id              uuid primary key default gen_random_uuid(),
  league_id       uuid not null references leagues (id) on delete cascade,
  fantasy_team_id uuid not null references fantasy_teams (id) on delete cascade,
  player_id       uuid not null references players (id) on delete cascade,
  acquired_via    acquisition_type not null default 'draft',
  acquired_at     timestamptz not null default now(),
  dropped_at      timestamptz,
  check (dropped_at is null or dropped_at >= acquired_at)
);

create unique index roster_entries_exclusive_ownership
  on roster_entries (league_id, player_id)
  where dropped_at is null;

create index roster_entries_active_team_idx
  on roster_entries (fantasy_team_id)
  where dropped_at is null;
