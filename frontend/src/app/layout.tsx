import type { Metadata } from "next";

import AppNav from "@/components/AppNav";

import "./globals.css";

export const metadata: Metadata = {
  title: "FatBoysFantasy",
  description: "Fantasy Premier League with a snake draft and head-to-head matchups",
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
        <AppNav />
        {children}
      </body>
    </html>
  );
}
