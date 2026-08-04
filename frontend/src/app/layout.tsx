import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "FantasyPrem",
  description: "Fantasy soccer for real-world leagues",
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
      <body className="min-h-screen antialiased" suppressHydrationWarning>
        {children}
      </body>
    </html>
  );
}
