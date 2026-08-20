"use client";

/**
 * Three-way theme: "light" | "dark" | "system". Stored under its own key
 * (not the workbench store) because it must be readable by the blocking
 * inline script in layout.tsx before React or zustand's persist middleware
 * have run — that's what keeps first paint from flashing the wrong theme.
 */
export type ThemePref = "light" | "dark" | "system";

export const THEME_KEY = "vyn.theme";

function resolveSystem(): "light" | "dark" {
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

/** Applies `pref` to the document. "system" removes the attribute entirely so
 *  the CSS's own `prefers-color-scheme` media query decides — see the note
 *  in globals.css above the light-theme block. */
export function applyTheme(pref: ThemePref) {
  const root = document.documentElement;
  if (pref === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", pref);
}

export function getStoredTheme(): ThemePref {
  const v = typeof window !== "undefined" ? localStorage.getItem(THEME_KEY) : null;
  return v === "light" || v === "dark" || v === "system" ? v : "system";
}

export function setStoredTheme(pref: ThemePref) {
  localStorage.setItem(THEME_KEY, pref);
  applyTheme(pref);
}

/** The theme actually in effect right now (resolves "system"), for the
 *  toggle's icon — it should show what you'd get by clicking, not the raw
 *  preference string. */
export function effectiveTheme(pref: ThemePref): "light" | "dark" {
  return pref === "system" ? resolveSystem() : pref;
}

/**
 * Source for the blocking `<script>` in layout.tsx. Runs before hydration so
 * `document.documentElement` already has the right `data-theme` at first
 * paint — inlined as a string (not imported) because it must execute
 * synchronously, standalone, ahead of any bundle.
 */
export const NO_FLASH_THEME_SCRIPT = `
(function () {
  try {
    var v = localStorage.getItem(${JSON.stringify(THEME_KEY)});
    if (v === "light" || v === "dark") {
      document.documentElement.setAttribute("data-theme", v);
    }
  } catch (e) {}
})();
`;
