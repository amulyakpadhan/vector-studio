import { UMAP } from "umap-js";
import { randomProjection } from "./reduce.ts";

export interface ProjectOptions {
  /** Output dimensions: 2 or 3. Default 3. */
  dims?: 2 | 3;
  /** UMAP neighbourhood size. Clamped to the sample size. Default 15. */
  nNeighbors?: number;
  /** UMAP minimum distance between points. Default 0.1. */
  minDist?: number;
  /** Pre-reduction target dimension before UMAP. Default 50. */
  preDim?: number;
  /** Deterministic seed. Default 42. */
  seed?: number;
}

export interface ProjectionResult {
  /** N × dims coordinates, one row per input vector. */
  positions: number[][];
  dims: 2 | 3;
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/**
 * Project high-dimensional vectors to 2D/3D for rendering.
 * Runs on whatever thread calls it, yielding to the event loop between UMAP
 * epochs so a browser UI stays responsive. `onProgress` reports 0..1.
 */
export async function projectVectors(
  vectors: number[][],
  opts: ProjectOptions = {},
  onProgress?: (p: number) => void,
): Promise<ProjectionResult> {
  const dims = opts.dims ?? 3;
  const n = vectors.length;

  if (n === 0) return { positions: [], dims };
  // UMAP needs at least a few points; below that, just center them at origin.
  if (n < 4) {
    return { positions: vectors.map(() => new Array(dims).fill(0)), dims };
  }

  onProgress?.(0);
  const reduced = randomProjection(vectors, opts.preDim ?? 50, opts.seed ?? 42);

  const nNeighbors = Math.max(2, Math.min(opts.nNeighbors ?? 15, n - 1));
  const umap = new UMAP({
    nComponents: dims,
    nNeighbors,
    minDist: opts.minDist ?? 0.1,
    random: mulberryFloat(opts.seed ?? 42),
  });

  const nEpochs = umap.initializeFit(reduced);
  for (let epoch = 0; epoch < nEpochs; epoch++) {
    umap.step();
    if (epoch % 10 === 0) {
      onProgress?.(epoch / nEpochs);
      await tick();
    }
  }
  onProgress?.(1);

  const embedding = umap.getEmbedding();
  return { positions: embedding, dims };
}

/** umap-js takes a `random: () => number`; give it a seeded one for stable layouts. */
function mulberryFloat(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
