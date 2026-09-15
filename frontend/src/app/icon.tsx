import { ImageResponse } from "next/og";

export const size = { width: 512, height: 512 };
export const contentType = "image/png";

/**
 * Generated at build time rather than checked in as a binary.
 *
 * Keeps the icon in step with the palette in globals.css — no separate asset to
 * forget about when the colours change — and avoids committing a PNG nobody can
 * diff.
 *
 * Padded heavily on purpose: this is also served as the maskable icon, and
 * Android crops maskable icons to whatever shape the launcher fancies. Only the
 * middle four-fifths is guaranteed to survive.
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
        <div
          style={{
            width: 300,
            height: 300,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 72,
            background: "#34d399",
            color: "#04231a",
            fontSize: 150,
            fontWeight: 700,
            letterSpacing: -6,
          }}
        >
          FB
        </div>
      </div>
    ),
    { ...size },
  );
}
