import { ImageResponse } from "next/og";

import { BALL_DATA_URL } from "@/lib/ballIcon";

export const size = { width: 512, height: 512 };
export const contentType = "image/png";

/**
 * Generated at build time rather than checked in as a binary. Keeps the icon in
 * step with the palette in globals.css, and avoids committing a PNG nobody can
 * diff.
 *
 * The ball is 300 of 512 on purpose: this is also served as the maskable icon,
 * and Android crops those to whatever shape the launcher fancies. Only the
 * middle four-fifths is guaranteed to survive, so anything larger risks losing
 * its edges to a circle mask.
 */
export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#0f172a",
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={BALL_DATA_URL} width={300} height={300} alt="" />
      </div>
    ),
    { ...size },
  );
}
