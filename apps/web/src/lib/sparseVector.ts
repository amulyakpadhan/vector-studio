import type { SparseVector } from "@vyn/core";

/** Parse a user-typed `{"indices": [...], "values": [...]}` sparse vector, or throw a clear error. */
export function parseSparseVector(raw: string): SparseVector {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    throw new Error('Sparse vector must be JSON, e.g. {"indices": [3, 91], "values": [0.5, 0.25]}.');
  }
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    throw new Error('Sparse vector must be a JSON object with "indices" and "values".');
  }
  const { indices, values } = obj as { indices?: unknown; values?: unknown };
  if (!Array.isArray(indices) || indices.some((n) => typeof n !== "number")) {
    throw new Error('Sparse vector "indices" must be an array of numbers.');
  }
  if (!Array.isArray(values) || values.some((n) => typeof n !== "number")) {
    throw new Error('Sparse vector "values" must be an array of numbers.');
  }
  if (indices.length !== values.length) {
    throw new Error('Sparse vector "indices" and "values" must be the same length.');
  }
  return { indices: indices as number[], values: values as number[] };
}
