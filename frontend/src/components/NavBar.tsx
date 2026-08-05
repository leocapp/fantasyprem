"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useState } from "react";

import { signOut } from "@/app/auth/actions";

type League = { id: string; name: string; status: string };

export default function NavBar({ email, leagues }: { email: string; leagues: League[] }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [open, setOpen] = useState(false);

  // League context comes from the path (/leagues/<id>/...) or, on pages that
  // live outside a league like /players, from a ?league= parameter.
  const leagueId =
    pathname.match(/^\/leagues\/([0-9a-f-]{36})/)?.[1] ?? searchParams.get("league") ?? undefined;
  const league = leagues.find((row) => row.id === leagueId);

  const links: { href: string; label: string }[] = league
    ? [
        { href: `/leagues/${league.id}`, label: "Overview" },
        { href: `/leagues/${league.id}/team`, label: "My team" },
        ...(league.status === "drafting" || league.status === "active"
          ? [{ href: `/leagues/${league.id}/draft`, label: "Draft" }]
          : []),
        ...(league.status === "active"
          ? [
              { href: `/leagues/${league.id}/free-agents`, label: "Free agents" },
              { href: `/leagues/${league.id}/trades`, label: "Trades" },
            ]
          : []),
        { href: `/players?league=${league.id}`, label: "Players" },
        { href: `/leagues/${league.id}/chat`, label: "Chat" },
      ]
    : [
        { href: "/leagues", label: "Leagues" },
        { href: "/players", label: "Players" },
      ];

  const isActive = (href: string) => {
    const path = href.split("?")[0];
    return path === pathname || (path !== "/" && pathname.startsWith(`${path}/`));
  };

  return (
    <header className="sticky top-0 z-20 border-b border-[var(--border)] bg-[var(--bg)]/95 backdrop-blur">
      <div className="mx-auto flex w-full max-w-4xl items-center gap-4 px-4 py-3">
        <Link href="/dashboard" className="font-bold tracking-tight">
          FantasyPrem
        </Link>

        {league ? (
          <span className="hidden truncate text-sm text-[var(--text-dim)] sm:inline">
            / {league.name}
          </span>
        ) : null}

        <nav className="ml-auto hidden items-center gap-1 sm:flex">
          {links.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className={`rounded-md px-2.5 py-1.5 text-sm transition-colors ${
                isActive(link.href)
                  ? "bg-[var(--surface-raised)] text-[var(--text)]"
                  : "text-[var(--text-muted)] hover:text-[var(--text)]"
              }`}
            >
              {link.label}
            </Link>
          ))}

          <form action={signOut} className="ml-2">
            <button
              className="text-sm text-[var(--text-dim)] hover:text-[var(--text)]"
              title={email}
            >
              Sign out
            </button>
          </form>
        </nav>

        <button
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-label="Menu"
          className="ml-auto rounded-md border border-[var(--border-strong)] px-2.5 py-1.5 text-sm sm:hidden"
        >
          Menu
        </button>
      </div>

      {open ? (
        <nav className="border-t border-[var(--border)] px-4 py-2 sm:hidden">
          {links.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              onClick={() => setOpen(false)}
              className={`block rounded-md px-2 py-2 text-sm ${
                isActive(link.href) ? "text-[var(--text)]" : "text-[var(--text-muted)]"
              }`}
            >
              {link.label}
            </Link>
          ))}

          {leagues.length > 1 ? (
            <div className="mt-2 border-t border-[var(--border)] pt-2">
              <p className="px-2 py-1 text-xs uppercase tracking-wide text-[var(--text-dim)]">
                Switch league
              </p>
              {leagues.map((row) => (
                <Link
                  key={row.id}
                  href={`/leagues/${row.id}`}
                  onClick={() => setOpen(false)}
                  className="block truncate rounded-md px-2 py-2 text-sm text-[var(--text-muted)]"
                >
                  {row.name}
                </Link>
              ))}
            </div>
          ) : null}

          <form action={signOut} className="mt-2 border-t border-[var(--border)] pt-2">
            <button className="px-2 py-2 text-sm text-[var(--text-dim)]">Sign out ({email})</button>
          </form>
        </nav>
      ) : null}
    </header>
  );
}
