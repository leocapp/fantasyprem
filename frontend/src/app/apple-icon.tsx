import { ImageResponse } from "next/og";

import { BALL_DATA_URL } from "@/lib/ballIcon";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

/**
 * iOS home screen icon.
 *
 * Separate from icon.tsx because iOS applies its own rounded mask and ignores
 * `purpose: maskable`, so the ball fills more of the square here — an icon
 * padded for Android's launcher looks lost on an iPhone.
 *
 * Opaque, because iOS composites transparency onto black rather than the
 * wallpaper, which turns a transparent corner into a visible notch.
 */
export default function AppleIcon() {
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
        <img src={BALL_DATA_URL} width={140} height={140} alt="" />
      </div>
    ),
    { ...size },
  );
}
