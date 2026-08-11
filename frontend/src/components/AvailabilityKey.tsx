const ENTRIES: [string, string][] = [
  ["var(--warning)", "Doubtful"],
  ["var(--danger)", "Injured or suspended"],
  ["var(--text-dim)", "Not in squad"],
];

/**
 * Legend for the availability dots. Worth stating once per screen: a coloured
 * dot with no key is a puzzle, and the alternative — labelling every row — is
 * far noisier.
 */
export default function AvailabilityKey({ className = "" }: { className?: string }) {
  return (
    <p className={`flex flex-wrap items-center gap-x-4 gap-y-1 text-xs ${className}`}>
      <span className="text-[var(--text-dim)]">Availability</span>
      {ENTRIES.map(([colour, label]) => (
        <span key={label} className="flex items-center gap-1.5 text-[var(--text-muted)]">
          <span
            className="inline-block h-1.5 w-1.5 rounded-full"
            style={{ background: colour }}
          />
          {label}
        </span>
      ))}
      <span className="text-[var(--text-dim)]">Hover a dot for the injury and return date</span>
    </p>
  );
}
