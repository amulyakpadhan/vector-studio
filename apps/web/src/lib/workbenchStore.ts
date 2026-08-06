"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

/** Per-connection state within the open workbench: which collections are open, and which is active. */
interface ConnectionWorkspace {
  openCollections: string[];
  activeCollection: string | null;
}

interface WorkbenchState {
  openConnectionIds: string[];
  activeConnectionId: string | null;
  byConnection: Record<string, ConnectionWorkspace>;
  openConnection: (id: string) => void;
  closeConnection: (id: string) => void;
  setActiveConnection: (id: string) => void;
  openCollection: (connectionId: string, name: string) => void;
  closeCollection: (connectionId: string, name: string) => void;
  setActiveCollection: (connectionId: string, name: string) => void;
  reorderCollections: (connectionId: string, dragged: string, target: string) => void;
  renameCollection: (connectionId: string, oldName: string, newName: string) => void;
}

function emptyWorkspace(): ConnectionWorkspace {
  return { openCollections: [], activeCollection: null };
}

/** Picks a neighbor to fall back to after removing `removed` from `list`, or null if list is now empty. */
function neighborAfterRemoval<T>(list: T[], removed: T, next: T[]): T | null {
  const idx = list.indexOf(removed);
  return next[Math.min(idx, next.length - 1)] ?? null;
}

export const useWorkbench = create<WorkbenchState>()(
  persist(
    (set) => ({
      openConnectionIds: [],
      activeConnectionId: null,
      byConnection: {},

      openConnection: (id) =>
        set((s) => ({
          openConnectionIds: s.openConnectionIds.includes(id) ? s.openConnectionIds : [...s.openConnectionIds, id],
          activeConnectionId: id,
          byConnection: s.byConnection[id] ? s.byConnection : { ...s.byConnection, [id]: emptyWorkspace() },
        })),

      closeConnection: (id) =>
        set((s) => {
          const openConnectionIds = s.openConnectionIds.filter((c) => c !== id);
          const byConnection = { ...s.byConnection };
          delete byConnection[id];
          const activeConnectionId =
            s.activeConnectionId === id
              ? neighborAfterRemoval(s.openConnectionIds, id, openConnectionIds)
              : s.activeConnectionId;
          return { openConnectionIds, byConnection, activeConnectionId };
        }),

      setActiveConnection: (id) => set({ activeConnectionId: id }),

      openCollection: (connectionId, name) =>
        set((s) => {
          const ws = s.byConnection[connectionId] ?? emptyWorkspace();
          const openCollections = ws.openCollections.includes(name) ? ws.openCollections : [...ws.openCollections, name];
          return { byConnection: { ...s.byConnection, [connectionId]: { openCollections, activeCollection: name } } };
        }),

      closeCollection: (connectionId, name) =>
        set((s) => {
          const ws = s.byConnection[connectionId];
          if (!ws) return {};
          const openCollections = ws.openCollections.filter((c) => c !== name);
          const activeCollection =
            ws.activeCollection === name ? neighborAfterRemoval(ws.openCollections, name, openCollections) : ws.activeCollection;
          return { byConnection: { ...s.byConnection, [connectionId]: { openCollections, activeCollection } } };
        }),

      setActiveCollection: (connectionId, name) =>
        set((s) => {
          const ws = s.byConnection[connectionId] ?? emptyWorkspace();
          return { byConnection: { ...s.byConnection, [connectionId]: { ...ws, activeCollection: name } } };
        }),

      renameCollection: (connectionId, oldName, newName) =>
        set((s) => {
          const ws = s.byConnection[connectionId];
          if (!ws) return {};
          return {
            byConnection: {
              ...s.byConnection,
              [connectionId]: {
                openCollections: ws.openCollections.map((c) => (c === oldName ? newName : c)),
                activeCollection: ws.activeCollection === oldName ? newName : ws.activeCollection,
              },
            },
          };
        }),

      reorderCollections: (connectionId, dragged, target) =>
        set((s) => {
          const ws = s.byConnection[connectionId];
          if (!ws || dragged === target) return {};
          const from = ws.openCollections.indexOf(dragged);
          const to = ws.openCollections.indexOf(target);
          if (from === -1 || to === -1) return {};
          const openCollections = [...ws.openCollections];
          openCollections.splice(from, 1);
          openCollections.splice(to, 0, dragged);
          return { byConnection: { ...s.byConnection, [connectionId]: { ...ws, openCollections } } };
        }),
    }),
    { name: "vyn.workbench.v1" },
  ),
);
