/**
 * Injury / availability marker from the FPL status code.
 *
 * Renders nothing for available players — a flag on every row would carry no
 * information. The dot is coloured by severity and the title holds the club's
 * own wording, which is more useful than any label we could invent.
 */
const STATUS: Record<string, { label: string; colour: string }> = {
  d: { label: "Doubtful", colour: "var(--warning)" },
  i: { label: "Injured", colour: "var(--danger)" },
  s: { label: "Suspended", colour: "var(--danger)" },
  u: { label: "Unavailable", colour: "var(--danger)" },
  n: { label: "Not in squad", colour: "var(--text-dim)" },
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "24 Oct" — formatted by hand to avoid locale differences between server and client. */
function returnDate(value: string): string {
  const parsed = new Date(`${value}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return value;
  return `${parsed.getDate()} ${MONTHS[parsed.getMonth()]}`;
}

export default function AvailabilityFlag({
  availability,
  news,
  expectedReturn,
  showLabel = false,
}: {
  availability: string | null | undefined;
  news?: string | null;
  expectedReturn?: string | null;
  showLabel?: boolean;
}) {
  if (!availability || availability === "a") return null;

  const status = STATUS[availability] ?? { label: "Unavailable", colour: "var(--danger)" };

  // "Out indefinitely" is materially worse news than a date, so say so rather
  // than leaving the absence of a date unexplained.
  const timing = expectedReturn ? `back ${returnDate(expectedReturn)}` : "no return date";

  const detail = [news || status.label, timing].join(" · ");

  // The padding is the point: a 6px dot is a miserable hover and tap target,
  // so the wrapper carries a much larger hit area than the mark it draws.
  return (
    <span
      className="-m-1.5 inline-flex shrink-0 cursor-help items-center gap-1 p-1.5 text-[11px]"
      style={{ color: status.colour }}
      title={detail}
      aria-label={detail}
    >
      <span
        className="inline-block h-2 w-2 rounded-full ring-2"
        style={{ background: status.colour, boxShadow: "0 0 0 3px rgb(0 0 0 / 0.15)" }}
      />
      {showLabel ? (
        <span>
          {status.label}
          {expectedReturn ? ` · back ${returnDate(expectedReturn)}` : ""}
        </span>
      ) : null}
    </span>
  );
}
