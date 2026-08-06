const PALETTE = ["#1fe0c4", "#4b9eff", "#f0b429", "#ef6ed0", "#8f7bff", "#ff8a5c", "#5ce0a0", "#ff5c7a"];

/** Deterministic per-connection accent color, so the same connection always gets the same tab color. */
export function colorForConnection(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return PALETTE[hash % PALETTE.length]!;
}
