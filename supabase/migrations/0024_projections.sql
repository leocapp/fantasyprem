-- 0024_projections.sql
-- Projections: expected performance per player per gameweek.
--
-- The central design decision is that expectations are stored LEAGUE-AGNOSTIC.
-- One row per player per gameweek holds expected minutes, goals, assists,
-- clean sheet probability and so on — facts about football, not about any
-- league's rules. Projected *points* are then derived by running those
-- expectations through a league's scoring_rules, exactly as score_gameweek
-- does with actual stats.
--
-- The alternative — projecting points per league — would multiply the rows by
-- the number of leagues and tangle the model up with scoring. This way a
-- league that pays 8 for a defender's goal sees different numbers for free.

-- --------------------------------------------------- inputs we now store ----

alter table clubs
  add column if not exists strength_attack_home  integer,
  add column if not exists strength_attack_away  integer,
  add column if not exists strength_defence_home integer,
  add column if not exists strength_defence_away integer;

alter table players
  -- FPL's price in tenths of a million. Their own valuation of a player's
  -- season-long output, and the best preseason signal available.
  add column if not exists price              integer,
  add column if not exists selected_by_percent numeric(5, 2);

alter table fixtures
  -- FPL's 1–5 difficulty rating for each side of the fixture.
  add column if not exists home_difficulty integer,
  add column if not exists away_difficulty integer;

-- ------------------------------------------------------- expectations ----

create table if not exists player_gameweek_expectations (
  player_id     uuid not null references players (id) on delete cascade,
  gameweek_id   uuid not null references gameweeks (id) on delete cascade,

  minutes       numeric(5, 1) not null default 0,
  -- Probability of reaching the 60-minute appearance threshold.
  full_game_probability numeric(4, 3) not null default 0,
  goals         numeric(5, 3) not null default 0,
  assists       numeric(5, 3) not null default 0,
  clean_sheet_probability numeric(4, 3) not null default 0,
  goals_conceded numeric(5, 2) not null default 0,
  saves         numeric(5, 2) not null default 0,
  yellow_cards  numeric(4, 3) not null default 0,

  -- How much history this is based on. Below a few matches the numbers are
  -- noise, and the UI hides them rather than pretending otherwise.
  matches_observed integer not null default 0,

  computed_at   timestamptz not null default now(),
  primary key (player_id, gameweek_id)
);

create index if not exists expectations_gameweek_idx
  on player_gameweek_expectations (gameweek_id);

alter table player_gameweek_expectations enable row level security;

create policy "expectations readable by signed-in users"
  on player_gameweek_expectations for select to authenticated using (true);

-- ------------------------------------------- projected points per league ----
-- The same rule resolution score_gameweek uses, applied to expectations.
-- Returns null when there isn't enough history for the number to mean
-- anything.

create or replace function projected_points(
  p_league_id uuid,
  p_player_id uuid,
  p_gameweek_id uuid,
  p_minimum_matches integer default 3
)
returns numeric
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_position player_position;
  v_e        player_gameweek_expectations%rowtype;
  v_total    numeric := 0;
begin
  select position into v_position from players where id = p_player_id;

  select * into v_e
    from player_gameweek_expectations
   where player_id = p_player_id and gameweek_id = p_gameweek_id;

  if not found or v_e.matches_observed < p_minimum_matches then
    return null;
  end if;

  -- Appearance: the 60-minute threshold is worth more, so split the two.
  v_total := v_total
    + v_e.full_game_probability * rule_points(p_league_id, 'minutes_full', v_position)
    + greatest(0, least(1, v_e.minutes / 60.0) - v_e.full_game_probability)
      * rule_points(p_league_id, 'minutes_played', v_position);

  v_total := v_total
    + v_e.goals   * rule_points(p_league_id, 'goals', v_position)
    + v_e.assists * rule_points(p_league_id, 'assists', v_position)
    + v_e.clean_sheet_probability * rule_points(p_league_id, 'clean_sheet', v_position)
    + (v_e.goals_conceded / 2.0) * rule_points(p_league_id, 'goals_conceded_2', v_position)
    + (v_e.saves / 3.0) * rule_points(p_league_id, 'saves_3', v_position)
    + v_e.yellow_cards * rule_points(p_league_id, 'yellow_cards', v_position);

  return round(v_total, 1);
end;
$$;

-- Resolves one scoring rule: position-specific wins, then the all-positions
-- rule, then zero. Extracted because the projection needs the same lookup
-- score_gameweek does inline.
create or replace function rule_points(
  p_league_id uuid,
  p_stat_key  text,
  p_position  player_position
)
returns numeric
language sql
security definer
stable
set search_path = public
as $$
  select coalesce(
    (select points from scoring_rules
      where league_id = p_league_id and stat_key = p_stat_key and applies_to = p_position),
    (select points from scoring_rules
      where league_id = p_league_id and stat_key = p_stat_key and applies_to is null),
    0
  );
$$;

revoke all on function projected_points(uuid, uuid, uuid, integer) from public;
revoke all on function rule_points(uuid, text, player_position) from public;

grant execute on function projected_points(uuid, uuid, uuid, integer) to authenticated, service_role;
grant execute on function rule_points(uuid, text, player_position) to authenticated, service_role;
