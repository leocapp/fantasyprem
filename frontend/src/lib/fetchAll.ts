/**
 * Read every row of a query, past PostgREST's cap.
 *
 * PostgREST returns at most 1,000 rows and says nothing about it — no error, no
 * flag, just a short array. That has cost this project twice: 9,000 match stats
 * silently truncated during the Sportmonks migration, and the draft board
 * quietly dropping players once draft_values passed a thousand rows per league.
 * Both looked like missing data rather than a broken read, which is what made
 * them expensive to find.
 *
 * Anything that can outgrow a thousand rows should come through here. A query
 * that genuinely has a small bound — one league's teams, one team's roster —
 * does not need it.
 */
const PAGE = 1000;

type Pageable<T> = {
  range: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>;
};

export async function fetchAll<T>(query: Pageable<T>): Promise<T[]> {
  const rows: T[] = [];
  let offset = 0;

  // The builder is reusable: each range() call issues its own request.
  for (;;) {
    const { data, error } = await query.range(offset, offset + PAGE - 1);

    if (error || !data) return rows;

    rows.push(...data);

    // A short page is the last page. An exactly-full one is ambiguous, so it
    // costs one more request to be sure.
    if (data.length < PAGE) return rows;

    offset += PAGE;

    // A runaway loop would be worse than truncation. Nothing here should
    // approach this.
    if (offset > 100_000) return rows;
  }
}
