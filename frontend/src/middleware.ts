import type { NextRequest } from "next/server";

import { updateSession } from "@/lib/supabase/middleware";

const LEAGUE_PATH = /^\/leagues\/([0-9a-f-]{36})/;

export async function middleware(request: NextRequest) {
  const response = await updateSession(request);

  // Remember the league being viewed so pages outside /leagues/<id> — the
  // account page, the player browser — can still show league-aware navigation.
  const match = request.nextUrl.pathname.match(LEAGUE_PATH);
  if (match) {
    response.cookies.set("fp_last_league", match[1], {
      path: "/",
      sameSite: "lax",
      maxAge: 60 * 60 * 24 * 30,
    });
  }

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
