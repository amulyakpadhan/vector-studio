"use client";

import { useEffect, useState } from "react";
import { applyTheme, effectiveTheme, getStoredTheme, setStoredTheme, type ThemePref } from "@/lib/theme";

const NEXT: Record<ThemePref, ThemePref> = { light: "dark", dark: "system", system: "light" };
const LABEL: Record<ThemePref, string> = { light: "Light", dark: "Dark", system: "System" };

/** Sun / moon / a half-filled circle for "system" — cycles light → dark →
 *  system → light on click. Placed as topbar chrome, next to the sidebar
 *  toggle it shares an `.icon-btn` style with. */
export function ThemeToggle() {
  const [pref, setPref] = useState<ThemePref>("system");
  const [mounted, setMounted] = useState(false);

  // Read the real preference after mount only — the inline script in
  // layout.tsx already applied it to the DOM before paint, so this is just
  // catching the React state up, not fixing a flash.
  useEffect(() => {
    setPref(getStoredTheme());
    setMounted(true);
  }, []);

  // If the pref is "system", keep the applied theme in sync when the OS
  // setting changes while the app is open.
  useEffect(() => {
    if (pref !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => applyTheme("system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [pref]);

  const cycle = () => {
    const next = NEXT[pref];
    setPref(next);
    setStoredTheme(next);
  };

  const shown = mounted ? effectiveTheme(pref) : "dark";

  return (
    <button
      className="icon-btn"
      onClick={cycle}
      aria-label={`Theme: ${LABEL[pref]}. Click to switch.`}
      title={`Theme: ${LABEL[pref]} (click to cycle)`}
    >
      {pref === "system" ? (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.3" />
          <path d="M8 2a6 6 0 0 1 0 12z" fill="currentColor" />
        </svg>
      ) : shown === "dark" ? (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M13.5 9.5A5.8 5.8 0 0 1 6.5 2.5 5.8 5.8 0 1 0 13.5 9.5z"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinejoin="round"
          />
        </svg>
      ) : (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="8" cy="8" r="3.2" stroke="currentColor" strokeWidth="1.3" />
          <g stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
            <path d="M8 1v1.4M8 13.6V15M15 8h-1.4M2.4 8H1M12.7 3.3l-1 1M4.3 11.7l-1 1M12.7 12.7l-1-1M4.3 4.3l-1-1" />
          </g>
        </svg>
      )}
    </button>
  );
}
