"use client";

import { useEffect, useState } from "react";
import { Landing } from "@/components/Landing";

/**
 * The root route. On the website this is the marketing landing page (with its
 * WebGL particle field). In the desktop build that page is the wrong thing on
 * two counts:
 *
 *  - Product: someone who installed the app doesn't need a "Launch the studio
 *    / Star on GitHub" marketing page — they should land on their connections.
 *  - Stability: the landing's continuous 60fps 4000-point WebGL field runs
 *    into WebView2's software-GL fallback, which is slow and memory-hungry
 *    enough to hang the window and eventually crash it with Out of Memory.
 *
 * So inside Tauri this redirects straight to /studio/ and never mounts Landing
 * (hence never boots the particle field). Everywhere else it renders Landing
 * exactly as before — the Tauri check only resolves client-side, and the
 * default render is Landing, so the website has no blank flash and still
 * server-renders/exports the real page.
 */
export function HomeGate() {
  const [redirecting, setRedirecting] = useState(false);

  useEffect(() => {
    if ("__TAURI_INTERNALS__" in window) {
      setRedirecting(true);
      window.location.replace("/studio/");
    }
  }, []);

  if (redirecting) return null;
  return <Landing />;
}
