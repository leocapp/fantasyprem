export type Bucket = {
  bucket: string;
  weeks: number;
  total: number;
  average: number;
};

const LABELS: Record<string, string> = {
  GK: "Goalkeeper",
  DEF: "Defence",
  MID: "Midfield",
  FWD: "Attack",
};

const ORDER = ["GK", "DEF", "MID", "FWD"];

/**
 * What the side averages, and where those points come from.
 *
 * The bar is share of the team's total, not a score out of anything — the
 * useful comparison is between your own lines, and against how many players
 * each line fields. Three forwards contributing a fifth of the points is a
 * different story from five defenders doing it.
 */
export default function ScoringBreakdown({ buckets }: { buckets: Bucket[] }) {
  const team = buckets.find((row) => row.bucket === "TEAM");

  if (!team || team.weeks === 0) {
    return (
      <section>
        <h2 className="section-label">Scoring</h2>
        <p className="mt-3 text-sm dim">
          Nothing to average yet — this appears once a gameweek has finished.
        </p>
      </section>
    );
  }

  const lines = ORDER.map((key) => buckets.find((row) => row.bucket === key)).filter(
    (row): row is Bucket => Boolean(row),
  );

  const teamTotal = Number(team.total) || 0;

  return (
    <section>
      <h2 className="section-label">Scoring</h2>

      <div className="mt-3 flex items-baseline gap-3">
        <span className="numeric text-3xl font-bold" style={{ color: "var(--accent-hover)" }}>
          {Number(team.average).toFixed(1)}
        </span>
        <span className="text-sm dim">
          points per week across {team.weeks} completed gameweek
          {team.weeks === 1 ? "" : "s"} · {Number(team.total).toFixed(0)} in total
        </span>
      </div>

      <ul className="list mt-3">
        {lines.map((line) => {
          const share = teamTotal > 0 ? (Number(line.total) / teamTotal) * 100 : 0;

          return (
            <li key={line.bucket} className="row gap-3">
              <span className="w-24 shrink-0 text-sm">{LABELS[line.bucket] ?? line.bucket}</span>

              <span className="flex-1">
                <span className="block h-1.5 w-full overflow-hidden rounded bg-[var(--surface-raised)]">
                  <span
                    className="block h-full rounded"
                    style={{
                      width: `${Math.max(share, 0)}%`,
                      background: "var(--accent-hover)",
                    }}
                  />
                </span>
              </span>

              <span className="numeric w-14 text-right text-sm">
                {Number(line.average).toFixed(1)}
              </span>
              <span className="numeric w-12 text-right text-xs dim">{share.toFixed(0)}%</span>
            </li>
          );
        })}
      </ul>

      <p className="mt-2 text-xs dim">
        Average points per gameweek from each line of the team, and its share of your
        total. A week with no lineup counts as nothing scored, because it was. The
        captain&apos;s double belongs to his own position, so the four lines add up to the
        team figure.
      </p>
    </section>
  );
}
