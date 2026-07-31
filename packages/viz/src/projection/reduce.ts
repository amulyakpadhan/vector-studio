/**
 * Fast pre-reduction before UMAP.
 *
 * High-dimensional vectors (768/1536/3072 dims) make UMAP's nearest-neighbour
 * step slow. We first project down to ~50 dims with a random Gaussian
 * projection (Johnson–Lindenstrauss): cheap, O(N·d·k), and it preserves
 * pairwise distances well enough to feed UMAP. A PCA / worker-offloaded
 * reducer can replace this later without changing callers.
 */

/** Deterministic PRNG so a given sample always projects the same way. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard-normal sample via Box–Muller, driven by the seeded PRNG. */
function gaussianSampler(rand: () => number): () => number {
  return () => {
    let u = 0;
    let v = 0;
    while (u === 0) u = rand();
    while (v === 0) v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
}

export function randomProjection(data: number[][], targetDim: number, seed = 42): number[][] {
  const n = data.length;
  if (n === 0) return [];
  const d = data[0]!.length;
  if (d <= targetDim) return data;

  // Projection matrix R (d × targetDim), entries ~ N(0, 1/targetDim).
  const gauss = gaussianSampler(mulberry32(seed));
  const scale = 1 / Math.sqrt(targetDim);
  const R: number[][] = new Array(d);
  for (let i = 0; i < d; i++) {
    const row = new Array<number>(targetDim);
    for (let j = 0; j < targetDim; j++) row[j] = gauss() * scale;
    R[i] = row;
  }

  // Y = data · R
  const out: number[][] = new Array(n);
  for (let i = 0; i < n; i++) {
    const src = data[i]!;
    const row = new Array<number>(targetDim).fill(0);
    for (let k = 0; k < d; k++) {
      const val = src[k]!;
      if (val === 0) continue;
      const rk = R[k]!;
      for (let j = 0; j < targetDim; j++) row[j] = row[j]! + val * rk[j]!;
    }
    out[i] = row;
  }
  return out;
}
