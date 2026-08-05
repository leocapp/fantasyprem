"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useState } from "react";

import { signOut } from "@/app/auth/actions";

type League = {
  id: string;
  name: string;
  status: string;
  /** True for the owner and for co-commissioners. */
  isCommissioner: boolean;
};

export default function NavBar({
  email,
  leagues,
  lastLeagueId,
}: {
  email: string;
  leagues: League[];
  lastLeagueId?: string | null;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [open, setOpen] = useState(false);

  // League context, in order of confidence: the path, an explicit ?league=
  // parameter, then the last league visited (a cookie set by middleware) so
  // pages like /account and /players keep their bearings.
  const remembered = pathname === "/leagues" ? undefined : (lastLeagueId ?? undefined);
  const leagueId =
    pathname.match(/^\/leagues\/([0-9a-f-]{36})/)?.[1] ??
    searchParams.get("league") ??
    remembered;

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
        ...(league.isCommissioner
          ? [{ href: `/leagues/${league.id}/settings`, label: "Settings" }]
          : []),
      ]
    : [
        { href: "/leagues", label: "Leagues" },
        { href: "/players", label: "Players" },
      ];

  const isActive = (href: string) => {
    const path = href.split("?")[0];
    return path === pathname || (path !== "/" && pathname.startsWith(`${path}/`));
  };

  // Commissioners get two extra links. Rather than collapsing the bar, tighten
  // it: smaller text and padding once there are enough links to need it.
  const dense = links.length > 5;
  const linkClass = dense ? "px-1.5 py-1 text-[13px]" : "px-2 py-1.5 text-sm";

  return (
    <header className="sticky top-0 z-20 border-b border-[var(--border)] bg-[var(--bg)]/95 backdrop-blur">
      {/* Wider than the page container: a commissioner sees eight links. */}
      <div className="mx-auto flex w-full max-w-6xl items-center gap-3 px-4 py-3">
        <Link href="/dashboard" className="font-bold tracking-tight">
          FantasyPrem
        </Link>

        {league ? (
          <span className="hidden max-w-[10rem] truncate text-sm text-[var(--text-dim)] xl:inline">
            / {league.name}
          </span>
        ) : null}

        <nav className="ml-auto hidden items-center gap-0.5 sm:flex">
          {links.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className={`whitespace-nowrap rounded-md transition-colors ${linkClass} ${
                isActive(link.href)
                  ? "bg-[var(--surface-raised)] text-[var(--text)]"
                  : "text-[var(--text-muted)] hover:text-[var(--text)]"
              }`}
            >
              {link.label}
            </Link>
          ))}

          <span className="mx-1 h-4 w-px bg-[var(--border)]" />

          <Link
            href="/account"
            className={`whitespace-nowrap rounded-md transition-colors ${linkClass} ${
              isActive("/account")
                ? "bg-[var(--surface-raised)] text-[var(--text)]"
                : "text-[var(--text-muted)] hover:text-[var(--text)]"
            }`}
          >
            Account
          </Link>

          <form action={signOut}>
            <button
              className={`whitespace-nowrap px-2 text-[var(--text-dim)] hover:text-[var(--text)] ${
                dense ? "text-[13px]" : "text-sm"
              }`}
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

          <Link
            href="/account"
            onClick={() => setOpen(false)}
            className="block rounded-md px-2 py-2 text-sm text-[var(--text-muted)]"
          >
            Account
          </Link>

          <form action={signOut} className="mt-2 border-t border-[var(--border)] pt-2">
            <button className="px-2 py-2 text-sm text-[var(--text-dim)]">Sign out ({email})</button>
          </form>
        </nav>
      ) : null}
    </header>
  );
}
