import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";

import AvatarUploader from "./AvatarUploader";
import { claimUsername, renameTeam, updateProfile } from "./actions";

type ProfileRow = {
  id: string;
  username: string | null;
  display_name: string | null;
  bio: string | null;
  avatar_url: string | null;
};

type MembershipRow = {
  id: string;
  name: string;
  leagues: { id: string; name: string } | null;
};

export const dynamic = "force-dynamic";

export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; message?: string }>;
}) {
  const { error, message } = await searchParams;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("id, username, display_name, bio, avatar_url")
    .eq("id", user.id)
    .maybeSingle<ProfileRow>();

  const { data: memberships } = await supabase
    .from("fantasy_teams")
    .select("id, name, leagues (id, name)")
    .eq("owner_id", user.id)
    .returns<MembershipRow[]>();

  const needsUsername = !profile?.username;

  return (
    <main className="page page-narrow">
      <div>
        <h1 className="page-title">Account</h1>
        <p className="page-subtitle">{user.email}</p>
      </div>

      {error ? <p className="notice notice-error">{error}</p> : null}
      {message ? <p className="notice notice-success">{message}</p> : null}

      {needsUsername ? (
        <section className="card card-accent">
          <h2 className="font-semibold">Choose a username</h2>
          <p className="mt-1 text-sm muted">
            This is how other managers will know you, and it can&apos;t be changed later.
          </p>
          <form action={claimUsername} className="mt-4 flex gap-2" suppressHydrationWarning>
            <input
              name="username"
              required
              pattern="[a-zA-Z][a-zA-Z0-9_]{2,29}"
              placeholder="username"
              className="input flex-1"
              suppressHydrationWarning
            />
            <button className="btn btn-primary">Claim</button>
          </form>
          <p className="mt-2 text-xs dim">
            Starts with a letter, 3–30 characters, letters, numbers and underscores.
          </p>
        </section>
      ) : (
        <section className="card">
          <h2 className="section-label">Username</h2>
          <p className="mt-1 text-lg font-medium">@{profile?.username}</p>
          <p className="mt-1 text-xs dim">Permanent — other managers identify you by this.</p>
        </section>
      )}

      <section className="card">
        <h2 className="section-label">Photo</h2>
        <div className="mt-3">
          <AvatarUploader userId={user.id} currentUrl={profile?.avatar_url ?? null} />
        </div>
      </section>

      <section className="card">
        <h2 className="section-label">Profile</h2>
        <form action={updateProfile} className="mt-3 flex flex-col gap-3" suppressHydrationWarning>
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="muted">Display name</span>
            <input
              name="display_name"
              defaultValue={profile?.display_name ?? ""}
              maxLength={60}
              placeholder="How your name appears"
              className="input"
              suppressHydrationWarning
            />
          </label>

          <label className="flex flex-col gap-1.5 text-sm">
            <span className="muted">Bio</span>
            <textarea
              name="bio"
              defaultValue={profile?.bio ?? ""}
              maxLength={400}
              rows={3}
              placeholder="Rivalries, allegiances, trash talk"
              className="input resize-y"
              suppressHydrationWarning
            />
          </label>

          <button className="btn btn-primary self-start">Save profile</button>
        </form>
      </section>

      <section className="card">
        <h2 className="section-label">Teams</h2>
        {memberships && memberships.length > 0 ? (
          <ul className="mt-3 flex flex-col gap-3">
            {memberships.map((membership) => (
              <li key={membership.id}>
                <p className="text-xs dim">{membership.leagues?.name}</p>
                <form
                  action={renameTeam}
                  className="mt-1 flex gap-2"
                  suppressHydrationWarning
                >
                  <input type="hidden" name="team_id" value={membership.id} />
                  <input
                    name="name"
                    defaultValue={membership.name}
                    minLength={2}
                    maxLength={40}
                    className="input flex-1"
                    suppressHydrationWarning
                  />
                  <button className="btn btn-ghost">Rename</button>
                </form>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm muted">You&apos;re not in any leagues yet.</p>
        )}
      </section>
    </main>
  );
}
