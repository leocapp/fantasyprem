"use client";

import { useEffect } from "react";

/**
 * Registers the service worker, which is what makes the site installable.
 *
 * Renders nothing. It lives as a component rather than a script tag so the
 * registration runs after hydration — the worker's only jobs are an offline
 * fallback and caching build assets, neither of which is worth delaying first
 * paint for.
 *
 * Failure is silent by design. A browser that refuses to register one (private
 * windows, some corporate policies, no HTTPS in a preview) should still get a
 * perfectly ordinary website.
 */
export default function ServiceWorker() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;

    // Dev rebuilds change chunk names constantly, and a worker caching them is
    // a source of confusing staleness while working on the app.
    if (process.env.NODE_ENV !== "production") return;

    navigator.serviceWorker.register("/sw.js").catch((error) => {
      console.error("Service worker registration failed —", error);
    });
  }, []);

  return null;
}
