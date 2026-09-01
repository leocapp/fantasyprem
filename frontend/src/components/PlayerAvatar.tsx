// Portrait, roughly 7:9, matching the source images from the Premier League CDN.
const SIZES = {
  sm: { className: "h-9 w-7 text-[10px]", width: 28, height: 36 },
  lg: { className: "h-20 w-16 text-lg", width: 64, height: 80 },
};

/**
 * Headshot from the Premier League CDN, with initials as a fallback.
 *
 * Plain <img> rather than next/image on purpose: these are small fixed-size
 * thumbnails from a third-party CDN whose paths occasionally change, and a
 * broken <img> degrades more gracefully than a failed optimiser request.
 */
export default function PlayerAvatar({
  src,
  name,
  size = "sm",
}: {
  src: string | null;
  name: string;
  size?: keyof typeof SIZES;
}) {
  const { className, width, height } = SIZES[size];

  if (!src) {
    return (
      <span
        className={`${className} flex shrink-0 items-center justify-center rounded bg-[var(--surface-raised)] font-medium text-[var(--text-dim)]`}
      >
        {name.slice(0, 2).toUpperCase()}
      </span>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt=""
      width={width}
      height={height}
      loading="lazy"
      className={`${className} shrink-0 rounded bg-[var(--surface-raised)] object-cover`}
    />
  );
}
