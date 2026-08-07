"use client";

import { useEffect, useState } from "react";

/**
 * The desktop build turns off the native OS window chrome (tauri.conf.json's
 * decorations: false) so the app can own its own title bar instead of a
 * generic Tauri-branded one — this renders that replacement: a slim drag
 * region with the brand mark and window controls wired to the real window.
 * Renders nothing outside Tauri (plain browser/Vercel has no window chrome
 * to replace, and the check itself only resolves client-side after mount).
 */
export function TauriTitleBar() {
  const [isTauri, setIsTauri] = useState(false);

  useEffect(() => {
    const tauri = "__TAURI_INTERNALS__" in window;
    setIsTauri(tauri);
    // Reserves room for the fixed title bar so page content (and the app's
    // own sticky in-page header) isn't rendered underneath it.
    if (tauri) document.body.classList.add("tauri-titlebar-active");
    return () => document.body.classList.remove("tauri-titlebar-active");
  }, []);

  if (!isTauri) return null;
  return <Controls />;
}

async function currentWindow() {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow();
}

function Controls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void (async () => {
      const win = await currentWindow();
      setMaximized(await win.isMaximized());
      unlisten = await win.onResized(async () => setMaximized(await win.isMaximized()));
    })();
    return () => unlisten?.();
  }, []);

  return (
    <div className="tauri-titlebar">
      <div className="tauri-titlebar-drag" data-tauri-drag-region>
        <span className="tauri-titlebar-mark">V</span>
        <span className="tauri-titlebar-name">Vyn Studio</span>
      </div>
      <div className="tauri-titlebar-controls">
        <button
          className="tauri-titlebar-btn"
          aria-label="Minimize"
          onClick={() => void currentWindow().then((w) => w.minimize())}
        >
          &#x2212;
        </button>
        <button
          className="tauri-titlebar-btn"
          aria-label={maximized ? "Restore" : "Maximize"}
          onClick={() => void currentWindow().then((w) => w.toggleMaximize())}
        >
          {maximized ? "❐" : "☐"}
        </button>
        <button
          className="tauri-titlebar-btn close"
          aria-label="Close"
          onClick={() => void currentWindow().then((w) => w.close())}
        >
          &#x2715;
        </button>
      </div>
    </div>
  );
}
