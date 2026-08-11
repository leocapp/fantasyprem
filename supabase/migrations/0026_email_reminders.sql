-- 0026_email_reminders.sql
-- Lineup deadline reminders by email.
--
-- Two switches, and both must be on for a message to send: the commissioner
-- can turn reminders off for a whole league, and each manager can opt out for
-- themselves. A league-wide off overrides individual preference — it's the
-- commissioner's league.
--
-- notifications_sent exists to make sending idempotent. The job runs hourly and
-- would otherwise re-send the same reminder every run until the deadline
-- passed. The unique constraint is the guarantee, not the job's own bookkeeping.

alter table leagues
  add column if not exists email_reminders boolean not null default true;

alter table profiles
  add column if not exists email_reminders boolean not null default true;

-- How many hours before a deadline the nudge goes out. Per league so a
-- commissioner can make it earlier for a slow-moving group.
alter table leagues
  add column if not exists reminder_hours_before integer not null default 4
  check (reminder_hours_before between 1 and 48);

create table if not exists notifications_sent (
  id              uuid primary key default gen_random_uuid(),
  kind            text not null,
  fantasy_team_id uuid not null references fantasy_teams (id) on delete cascade,
  -- What the notification was about: a gameweek id for lineup reminders.
  subject_id      uuid not null,
  sent_at         timestamptz not null default now(),
  unique (kind, fantasy_team_id, subject_id)
);

create index if not exists notifications_sent_recent
  on notifications_sent (sent_at desc);

alter table notifications_sent enable row level security;

-- Only the service role writes these, and nobody needs to read them in the
-- app, so there are deliberately no policies.

-- ------------------------------------------------- who needs a reminder ----
-- Everything the job needs in one query: teams in active leagues whose
-- deadline is close, who haven't set a lineup, and who haven't already been
-- told. Kept in SQL because the conditions are joins, and doing it in Python
-- would mean fetching most of the database to filter it down.

create or replace function lineup_reminders_due()
returns table (
  fantasy_team_id uuid,
  team_name       text,
  league_id       uuid,
  league_name     text,
  gameweek_id     uuid,
  gameweek_number integer,
  deadline_at     timestamptz,
  email           text,
  username        text,
  carries_forward boolean
)
language sql
security definer
stable
set search_path = public
as $$
  select
    ft.id,
    ft.name,
    l.id,
    l.name,
    g.id,
    g.number,
    g.deadline_at,
    u.email,
    p.username,
    -- A manager whose previous lineup will roll over isn't in trouble, so the
    -- email says something different.
    l.carry_forward_lineups and exists (
      select 1 from lineups prev
      join gameweeks pg on pg.id = prev.gameweek_id
      where prev.fantasy_team_id = ft.id and pg.number < g.number
    )
  from fantasy_teams ft
  join leagues l on l.id = ft.league_id
  join gameweeks g on g.season_id = l.season_id
  join profiles p on p.id = ft.owner_id
  join auth.users u on u.id = ft.owner_id
  where l.status = 'active'
    and l.email_reminders
    and p.email_reminders
    and u.email is not null
    and g.deadline_at > now()
    and g.deadline_at <= now() + make_interval(hours => l.reminder_hours_before)
    and not exists (
      select 1 from lineups li
       where li.fantasy_team_id = ft.id and li.gameweek_id = g.id
    )
    and not exists (
      select 1 from notifications_sent ns
       where ns.kind = 'lineup_reminder'
         and ns.fantasy_team_id = ft.id
         and ns.subject_id = g.id
    );
$$;

revoke all on function lineup_reminders_due() from public;
grant execute on function lineup_reminders_due() to service_role;
