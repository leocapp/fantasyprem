"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";

const USERNAME_PATTERN = /^[a-z][a-z0-9_]{2,29}$/;

export async function claimUsername(formData: FormData) {
  const username = String(formData.get("username") ?? "")
    .trim()
    .toLowerCase();

  if (!USERNAME_PATTERN.test(username)) {
    redirect(
      "/account?error=Usernames+start+with+a+letter+and+use+3-30+letters,+numbers+or+underscores.",
    );
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const { error } = await supabase.from("profiles").update({ username }).eq("id", user.id);

  if (error) {
    const message =
      error.code === "23505" ? "That username is taken." : error.message;
    redirect(`/account?error=${encodeURIComponent(message)}`);
  }

  revalidatePath("/", "layout");
  redirect("/account?message=Username+set.");
}

export async function updateProfile(formData: FormData) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const { error } = await supabase
    .from("profiles")
    .update({
      display_name: String(formData.get("display_name") ?? "").trim() || null,
      bio: String(formData.get("bio") ?? "").trim() || null,
    })
    .eq("id", user.id);

  if (error) {
    redirect(`/account?error=${encodeURIComponent(error.message)}`);
  }

  revalidatePath("/", "layout");
  redirect("/account?message=Profile+updated.");
}

export async function renameTeam(formData: FormData) {
  const supabase = await createClient();

  const { error } = await supabase.rpc("rename_team", {
    p_team_id: String(formData.get("team_id")),
    p_name: String(formData.get("name") ?? ""),
  });

  if (error) {
    redirect(`/account?error=${encodeURIComponent(error.message)}`);
  }

  revalidatePath("/", "layout");
  redirect("/account?message=Team+renamed.");
}
