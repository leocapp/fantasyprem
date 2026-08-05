-- 0015_league_chat.sql
-- One chat channel per league.
--
-- Unlike drafts and trades there is no function here: the RLS policies are the
-- whole rule set, so clients can insert directly. The insert policy pins the
-- author to auth.uid() and the team to one the caller actually owns, which
-- means nobody can post as somebody else even by crafting the request.

create table league_messages (
  id              uuid primary key default gen_random_uuid(),
  league_id       uuid not null references leagues (id) on delete cascade,
  fantasy_team_id uuid not null references fantasy_teams (id) on delete cascade,
  author_id       uuid not null references profiles (id) on delete cascade,
  body            text not null check (char_length(btrim(body)) between 1 and 2000),
  created_at      timestamptz not null default now()
);

create index league_messages_recent on league_messages (league_id, created_at desc);

alter table league_messages enable row level security;

create policy "members read league messages"
  on league_messages for select to authenticated
  using (is_league_member(league_id));

create policy "members post as themselves"
  on league_messages for insert to authenticated
  with check (
    author_id = auth.uid()
    and exists (
      select 1 from fantasy_teams t
       where t.id = fantasy_team_id
         and t.owner_id = auth.uid()
         and t.league_id = league_messages.league_id
    )
  );

create policy "authors delete their own messages"
  on league_messages for delete to authenticated
  using (author_id = auth.uid());

-- Realtime still applies RLS, so only league members receive these.
do $$
begin
  alter publication supabase_realtime add table league_messages;
exception
  when duplicate_object then null;
end;
$$;
