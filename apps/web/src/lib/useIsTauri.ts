"use client";

import { useEffect, useState } from "react";

/**
 * True when running inside the Tauri desktop shell. Resolves to false on the
 * first (server/export) render and flips after mount — the Tauri global only
 * exists client-side. Use it to hide desktop-irrelevant UI (e.g. the local
 * bridge, which the native http_fetch proxy replaces there).
 */
export function useIsTauri(): boolean {
  const [isTauri, setIsTauri] = useState(false);
  useEffect(() => {
    setIsTauri("__TAURI_INTERNALS__" in window);
  }, []);
  return isTauri;
}
