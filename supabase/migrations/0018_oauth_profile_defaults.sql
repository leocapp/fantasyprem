-- 0018_oauth_profile_defaults.sql
-- Google sign-in supplies a name and picture. Use them as defaults so an OAuth
-- user's profile isn't empty on arrival.
--
-- Username is deliberately not derived from the Google account: it's permanent
-- and unique, so it has to be a deliberate choice rather than something we
-- guess and they're stuck with.

create or replace function handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name, avatar_url)
  values (
    new.id,
    coalesce(
      new.raw_user_meta_data ->> 'full_name',
      new.raw_user_meta_data ->> 'name',
      split_part(new.email, '@', 1)
    ),
    coalesce(
      new.raw_user_meta_data ->> 'avatar_url',
      new.raw_user_meta_data ->> 'picture'
    )
  )
  on conflict (id) do nothing;

  return new;
end;
$$;
