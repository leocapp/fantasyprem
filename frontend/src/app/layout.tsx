import type { Metadata, Viewport } from "next";

import AppNav from "@/components/AppNav";
import ServiceWorker from "@/components/ServiceWorker";

import "./globals.css";

export const metadata: Metadata = {
  title: "FatBoysFantasy",
  description: "Fantasy Premier League with a snake draft and head-to-head matchups",
  // Next links /manifest.webmanifest automatically from app/manifest.ts.
  appleWebApp: {
    capable: true,
    title: "FatBoys",
    // The status bar sits over our own background rather than a white strip,
    // which is the difference between "installed app" and "website in a frame".
    statusBarStyle: "black-translucent",
  },
};

export const viewport: Viewport = {
  // Matches --bg and the manifest. Painted before any CSS loads, so a mismatch
  // shows as a flash of the wrong colour on every launch.
  themeColor: "#0f172a",
  // A fantasy app is read one-handed on a phone at 10am on a Saturday. Letting
  // it scale is worth more than pixel-perfect control.
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      {/* suppressHydrationWarning: browser extensions (Grammarly, etc.) inject
          attributes into <body> before React hydrates. */}
      <body className="min-h-screen" suppressHydrationWarning>
        <ServiceWorker />
        <AppNav />
        {children}
      </body>
    </html>
  );
}
