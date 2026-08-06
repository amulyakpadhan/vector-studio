"use client";

import { create } from "zustand";

interface ConfirmRequest {
  id: number;
  title?: string;
  message: string;
  confirmLabel?: string;
  /** Renders the confirm button as destructive (red) instead of primary (teal). */
  danger?: boolean;
  resolve: (ok: boolean) => void;
}

interface ConfirmState {
  request: ConfirmRequest | null;
  ask: (opts: Omit<ConfirmRequest, "id" | "resolve">) => Promise<boolean>;
  resolve: (ok: boolean) => void;
}

const useConfirmState = create<ConfirmState>((set, get) => ({
  request: null,
  ask: (opts) =>
    new Promise<boolean>((resolve) => {
      set({ request: { id: Date.now() + Math.random(), resolve, ...opts } });
    }),
  resolve: (ok) => {
    get().request?.resolve(ok);
    set({ request: null });
  },
}));

export { useConfirmState };

/**
 * Drop-in async replacement for window.confirm() — styled to match the app instead of the
 * browser's native, unstyleable dialog. `await confirmDialog(...)` in place of `confirm(...)`.
 */
export function confirmDialog(
  message: string,
  opts?: { title?: string; confirmLabel?: string; danger?: boolean },
): Promise<boolean> {
  return useConfirmState.getState().ask({ message, ...opts });
}
