"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { createClient } from "@/lib/supabase/client";

const MAX_BYTES = 2 * 1024 * 1024;

/**
 * Uploads straight from the browser to Supabase Storage. The bucket's policies
 * restrict writes to a folder named after the user's id, so the upload path is
 * the authorisation — there's nothing for a server action to check.
 */
export default function AvatarUploader({
  userId,
  currentUrl,
}: {
  userId: string;
  currentUrl: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(currentUrl);

  async function upload(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    if (file.size > MAX_BYTES) {
      setError("Images must be under 2 MB.");
      return;
    }

    setBusy(true);
    setError(null);

    const supabase = createClient();
    const extension = file.name.split(".").pop()?.toLowerCase() ?? "png";
    const path = `${userId}/avatar.${extension}`;

    const { error: uploadError } = await supabase.storage
      .from("avatars")
      .upload(path, file, { upsert: true, contentType: file.type });

    if (uploadError) {
      setError(uploadError.message);
      setBusy(false);
      return;
    }

    const {
      data: { publicUrl },
    } = supabase.storage.from("avatars").getPublicUrl(path);

    // Cache-bust: the path is stable across replacements, so browsers would
    // keep showing the old image.
    const url = `${publicUrl}?v=${Date.now()}`;

    const { error: profileError } = await supabase
      .from("profiles")
      .update({ avatar_url: url })
      .eq("id", userId);

    if (profileError) {
      setError(profileError.message);
    } else {
      setPreview(url);
      router.refresh();
    }

    setBusy(false);
  }

  return (
    <div className="flex items-center gap-4">
      {preview ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={preview}
          alt=""
          width={64}
          height={64}
          className="h-16 w-16 rounded-full bg-[var(--surface-raised)] object-cover"
        />
      ) : (
        <span className="flex h-16 w-16 items-center justify-center rounded-full bg-[var(--surface-raised)] text-xs text-[var(--text-dim)]">
          none
        </span>
      )}

      <div className="flex flex-col gap-1">
        <label className="btn btn-ghost btn-sm cursor-pointer">
          {busy ? "Uploading…" : "Choose image"}
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            onChange={upload}
            disabled={busy}
            className="hidden"
          />
        </label>
        <span className="text-xs text-[var(--text-dim)]">PNG, JPG, WebP or GIF · up to 2 MB</span>
        {error ? <span className="text-xs text-[var(--danger)]">{error}</span> : null}
      </div>
    </div>
  );
}
