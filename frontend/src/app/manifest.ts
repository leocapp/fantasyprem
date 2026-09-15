import type { MetadataRoute } from "next";

/**
 * What makes the site installable.
 *
 * Next generates /manifest.webmanifest from this and links it automatically, so
 * there is no file in public/ to keep in step with the app's colours.
 *
 * display: "standalone" is the part that matters — launched from the home
 * screen there is no address bar, no tabs, and it stops looking like a website
 * someone bookmarked.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "FatBoysFantasy",
    short_name: "FatBoys",
    description: "Fantasy Premier League with a snake draft and head-to-head matchups",
    start_url: "/dashboard",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    // Matches --bg in globals.css. The splash screen and the status bar are
    // painted with these before any of our CSS loads, so a mismatch shows as a
    // white flash on every launch.
    background_color: "#0f172a",
    theme_color: "#0f172a",
    categories: ["sports"],
    icons: [
      { src: "/icon", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon", sizes: "512x512", type: "image/png", purpose: "maskable" },
      { src: "/apple-icon", sizes: "180x180", type: "image/png" },
    ],
  };
}
