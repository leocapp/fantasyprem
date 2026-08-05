/**
 * Headshot from the Premier League CDN, with initials as a fallback.
 *
 * Plain <img> rather than next/image on purpose: these are small fixed-size
 * thumbnails from a third-party CDN whose paths occasionally change, and a
 * broken <img> degrades more gracefully than a failed optimiser request.
 */
export default function PlayerAvatar({ src, name }: { src: string | null; name: string }) {
  if (!src) {
    return (
      <span className="flex h-9 w-7 shrink-0 items-center justify-center rounded bg-[var(--surface-raised)] text-[10px] font-medium text-[var(--text-dim)]">
        {name.slice(0, 2).toUpperCase()}
      </span>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt=""
      width={28}
      height={36}
      loading="lazy"
      className="h-9 w-7 shrink-0 rounded bg-[var(--surface-raised)] object-cover"
    />
  );
}
