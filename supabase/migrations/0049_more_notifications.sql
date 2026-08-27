-- 0049_more_notifications.sql
-- Two more emails, on the machinery 0026 already built.
--
-- Both follow the same shape as lineup_reminders_due: everything the job needs
-- in one query, both opt-out switches respected, and a not-exists against
-- notifications_sent so the hourly run doesn't re-send. Only the `kind` and the
-- subject id differ, so the unique constraint keeps doing the real work.
--
-- Reusing profiles.email_reminders for all three rather than adding a
-- preference column per email. Three switches for a seven-person league is a
-- settings page nobody reads; if anyone wants only some of these, that is the
-- moment to split it, not before.

-- ------------------------------------------------- an injured starter ----
-- Someone in your saved XI has been ruled out. Deliberately in the same window
-- as the lineup reminder, and the two can never both fire at the same manager:
-- that one requires no lineup, this one requires a lineup. Disjoint by
-- construction rather than by a rule someone has to remember.
--
-- 'd' — doubtful — counts here, unlike on injury reserve. Reserving a doubtful
-- player would buy a roster slot on a maybe, but *telling* you he's doubtful is
-- exactly the sort of thing you'd want to know before a deadline. The email
-- says which is which.

create or replace function injured_starters_due()
returns table (
  fantasy_team_id uuid,
  team_name       text,
  league_id       uuid,
  league_name     text,
  gameweek_id     uuid,
  gameweek_number integer,
  deadline_at     timestamptz,
  email           text,
  players         jsonb
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
    jsonb_agg(
      jsonb_build_object(
        'name',            pl.display_name,
        'position',        pl.position,
        'availability',    pl.availability,
        'news',            pl.news,
        'expected_return', pl.expected_return
      )
      order by pl.display_name
    )
  from fantasy_teams ft
  join leagues l on l.id = ft.league_id
  join gameweeks g on g.season_id = l.season_id
  join profiles p on p.id = ft.owner_id
  join auth.users u on u.id = ft.owner_id
  join lineups li on li.fantasy_team_id = ft.id and li.gameweek_id = g.id
  join lineup_players lp on lp.lineup_id = li.id and lp.role = 'starter'
  join players pl on pl.id = lp.player_id
  where l.status = 'active'
    and l.email_reminders
    and p.email_reminders
    and u.email is not null
    and g.deadline_at > now()
    and g.deadline_at <= now() + make_interval(hours => l.reminder_hours_before)
    and pl.availability is not null
    and pl.availability <> 'a'
    and not exists (
      select 1 from notifications_sent ns
       where ns.kind = 'injured_starter'
         and ns.fantasy_team_id = ft.id
         and ns.subject_id = g.id
    )
  group by ft.id, ft.name, l.id, l.name, g.id, g.number, g.deadline_at, u.email;
$$;

comment on function injured_starters_due() is
  'Managers whose saved XI contains a player the provider has flagged, with the '
  'deadline close enough to still do something about it.';

revoke all on function injured_starters_due() from public;
grant execute on function injured_starters_due() to service_role;

-- ------------------------------------------------------ gameweek recap ----
-- Sent when the gameweek settles, not on a fixed day. Those are different
-- things: a deferred fixture leaves a gameweek provisional for a week or more,
-- and a Monday-morning recap would report a result that later changes. Waiting
-- on g.status = 'complete' means the email is always about a final score, and a
-- postponed match simply makes it arrive late.

create or replace function gameweek_recaps_due()
returns table (
  fantasy_team_id uuid,
  team_name       text,
  league_id       uuid,
  league_name     text,
  gameweek_id     uuid,
  gameweek_number integer,
  email           text,
  points          numeric,
  opponent_name   text,
  opponent_points numeric,
  outcome         text,
  wins            bigint,
  losses          bigint,
  draws           bigint,
  standing        bigint,
  teams_in_league bigint
)
language sql
security definer
stable
set search_path = public
as $$
  with sides as (
    -- A bye is on the home side and has no opponent row, so it appears once
    -- here with a null opponent — which the select below renders as the field.
    select m.league_id, m.gameweek_id, m.home_team_id as team_id,
           m.away_team_id as opponent_id, m.home_points as points,
           m.away_points as conceded
      from matchups m
     where m.status = 'final'
     union all
    select m.league_id, m.gameweek_id, m.away_team_id,
           m.home_team_id, m.away_points, m.home_points
      from matchups m
     where m.status = 'final' and m.away_team_id is not null
  ),
  table_now as (
    select
      s.league_id,
      s.team_id,
      s.wins,
      s.losses,
      s.draws,
      rank() over (
        partition by s.league_id order by s.wins desc, s.points_for desc
      ) as standing,
      count(*) over (partition by s.league_id) as teams_in_league
    from league_standings s
  )
  select
    ft.id,
    ft.name,
    l.id,
    l.name,
    g.id,
    g.number,
    u.email,
    sd.points,
    coalesce(opp.name, 'the field'),
    sd.conceded,
    case when sd.points > sd.conceded then 'win'
         when sd.points < sd.conceded then 'loss'
         else 'draw' end,
    t.wins,
    t.losses,
    t.draws,
    t.standing,
    t.teams_in_league
  from sides sd
  join fantasy_teams ft on ft.id = sd.team_id
  join leagues l on l.id = ft.league_id
  join gameweeks g on g.id = sd.gameweek_id
  join profiles p on p.id = ft.owner_id
  join auth.users u on u.id = ft.owner_id
  join table_now t on t.league_id = l.id and t.team_id = ft.id
  left join fantasy_teams opp on opp.id = sd.opponent_id
  where l.status = 'active'
    and l.email_reminders
    and p.email_reminders
    and u.email is not null
    and g.status = 'complete'
    and not exists (
      select 1 from notifications_sent ns
       where ns.kind = 'gameweek_recap'
         and ns.fantasy_team_id = ft.id
         and ns.subject_id = g.id
    );
$$;

comment on function gameweek_recaps_due() is
  'One row per manager per settled gameweek: their score, the result, and where '
  'it leaves them. Waits for every fixture to be played, so a deferred match '
  'delays the email rather than making it wrong.';

revoke all on function gameweek_recaps_due() from public;
grant execute on function gameweek_recaps_due() to service_role;

-- --------------------------------------------------------- default timing ----
-- Four hours before a deadline sounds generous until you work out when the
-- deadline is. It's ten minutes before the first kickoff, and a Saturday 12:30
-- in England is 07:30 on the east coast — so the nudge landed at half past
-- three in the morning. Two hours puts it at 05:30, which is at least the most
-- recent thing in the inbox on waking.
--
-- Existing leagues are left alone; change them in league settings.

alter table leagues
  alter column reminder_hours_before set default 2;
