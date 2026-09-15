import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

/**
 * iOS home screen icon.
 *
 * Separate from icon.tsx because iOS applies its own rounded mask and does not
 * honour `purpose: maskable`, so this one fills the square rather than sitting
 * in a safe zone — an icon padded for Android looks lost on an iPhone.
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
          background: "#34d399",
          color: "#04231a",
          fontSize: 86,
          fontWeight: 700,
          letterSpacing: -4,
        }}
      >
        FB
      </div>
    ),
    { ...size },
  );
}
