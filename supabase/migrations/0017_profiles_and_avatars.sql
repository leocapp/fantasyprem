-- 0017_profiles_and_avatars.sql
-- Manager identity: permanent username, editable display name and bio, and an
-- uploaded avatar.
--
-- The username is deliberately immutable. It appears next to team names all
-- over the app, and a name that can change is a name nobody can rely on to
-- identify who they traded with three weeks ago.

alter table profiles add column if not exists bio text check (char_length(bio) <= 400);

-- Lowercase letters, digits and underscores, starting with a letter.
alter table profiles
  add constraint profiles_username_format
  check (username is null or username ~ '^[a-z][a-z0-9_]{2,29}$')
  not valid;

-- --------------------------------------------------- username is forever ----

create or replace function enforce_username_immutable()
returns trigger
language plpgsql
as $$
begin
  if old.username is not null and new.username is distinct from old.username then
    raise exception 'Usernames cannot be changed once set.';
  end if;
  return new;
end;
$$;

create trigger profiles_username_immutable
  before update on profiles
  for each row execute function enforce_username_immutable();

-- ------------------------------------------------------------ rename team ----
-- Team names are per league, so renaming needs the league's uniqueness check.
-- The RLS policy already allows owners to update their own team; this exists to
-- give a clear error instead of a raw constraint violation.

create or replace function rename_team(p_team_id uuid, p_name text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_league_id uuid;
  v_name      text := btrim(p_name);
begin
  select league_id into v_league_id
    from fantasy_teams
   where id = p_team_id and owner_id = auth.uid();

  if v_league_id is null then
    raise exception 'That is not your team.';
  end if;

  if char_length(v_name) < 2 or char_length(v_name) > 40 then
    raise exception 'Team names must be between 2 and 40 characters.';
  end if;

  if exists (
    select 1 from fantasy_teams
     where league_id = v_league_id and name = v_name and id <> p_team_id
  ) then
    raise exception 'Another team in this league is already called that.';
  end if;

  update fantasy_teams set name = v_name where id = p_team_id;
end;
$$;

revoke all on function rename_team(uuid, text) from public;
grant execute on function rename_team(uuid, text) to authenticated;

-- ---------------------------------------------------------------- avatars ----
-- Public bucket: avatars are shown to every league member, and a public read is
-- simpler than signing every URL. Writes are locked to a folder named after the
-- user's id, so nobody can overwrite somebody else's picture.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'avatars',
  'avatars',
  true,
  2097152,  -- 2 MB
  array['image/png', 'image/jpeg', 'image/webp', 'image/gif']
)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

do $$
begin
  create policy "avatars are publicly readable"
    on storage.objects for select
    using (bucket_id = 'avatars');
exception
  when duplicate_object then null;
end;
$$;

do $$
begin
  create policy "users upload their own avatar"
    on storage.objects for insert to authenticated
    with check (
      bucket_id = 'avatars'
      and (storage.foldername(name))[1] = auth.uid()::text
    );
exception
  when duplicate_object then null;
end;
$$;

do $$
begin
  create policy "users replace their own avatar"
    on storage.objects for update to authenticated
    using (
      bucket_id = 'avatars'
      and (storage.foldername(name))[1] = auth.uid()::text
    );
exception
  when duplicate_object then null;
end;
$$;

do $$
begin
  create policy "users delete their own avatar"
    on storage.objects for delete to authenticated
    using (
      bucket_id = 'avatars'
      and (storage.foldername(name))[1] = auth.uid()::text
    );
exception
  when duplicate_object then null;
end;
$$;
