"use client";

import { useEffect, useState } from "react";

/** Where the local bridge listens by default (see @vyn/bridge). */
export const BRIDGE_URL = "http://127.0.0.1:7391";

export type BridgeStatus = "checking" | "online" | "offline";

interface BridgeHealth {
  ok: boolean;
  name: string;
  version: string;
}

/** Ping the local bridge's /health once, with a short timeout. */
export async function pingBridge(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1200);
    const res = await fetch(`${BRIDGE_URL}/health`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return false;
    const body = (await res.json()) as BridgeHealth;
    return body.ok === true && body.name === "vyn-bridge";
  } catch {
    return false;
  }
}

/** React hook: detect the bridge on mount (and expose a manual re-check). */
export function useBridge(): { status: BridgeStatus; recheck: () => void } {
  const [status, setStatus] = useState<BridgeStatus>("checking");
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    // No bridge in the desktop app (native http_fetch replaces it) — skip the
    // probe entirely rather than firing a pointless request to 127.0.0.1:7391.
    if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
      setStatus("offline");
      return;
    }
    let cancelled = false;
    setStatus("checking");
    pingBridge().then((ok) => {
      if (!cancelled) setStatus(ok ? "online" : "offline");
    });
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  return { status, recheck: () => setNonce((n) => n + 1) };
}
