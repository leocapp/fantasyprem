const SIZES = { sm: "h-6 w-6 text-[9px]", md: "h-8 w-8 text-[11px]", lg: "h-12 w-12 text-sm" };

/**
 * Round manager avatar, falling back to the first two characters of the
 * username. Plain <img> rather than next/image: these are small, fixed-size,
 * and come from Supabase Storage with a cache-busting query string.
 */
export default function ManagerAvatar({
  src,
  username,
  size = "sm",
}: {
  src: string | null | undefined;
  username: string | null | undefined;
  size?: keyof typeof SIZES;
}) {
  const classes = `${SIZES[size]} shrink-0 rounded-full bg-[var(--surface-raised)] object-cover`;

  if (!src) {
    return (
      <span
        className={`${classes} flex items-center justify-center font-semibold uppercase text-[var(--text-dim)]`}
        aria-hidden
      >
        {(username ?? "?").slice(0, 2)}
      </span>
    );
  }

  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt="" className={classes} loading="lazy" />;
}
