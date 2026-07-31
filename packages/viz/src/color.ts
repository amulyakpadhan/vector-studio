/**
 * Turn a metadata field into per-point RGB colors.
 * Categorical values get a distinct hue each; numeric values map onto the
 * brand aqua→violet ramp. Colors are returned as a flat Float32Array
 * (r,g,b per point in 0..1) ready for a Three.js color attribute.
 */

export type FieldValue = string | number | boolean | null | undefined;

/** Distinct, legible categorical hues (brand-forward, then supporting tones). */
export const CATEGORICAL: string[] = [
  "#1fe0c4", // aqua (brand)
  "#7a5cff", // violet (brand)
  "#ff6b8a", // coral
  "#37b6ff", // sky
  "#ffbc5c", // amber
  "#2fd39a", // green
  "#ff9d5c", // orange
  "#c07bff", // purple
  "#5ce1ff", // cyan
  "#ff7ad4", // pink
];

/** Default point color when no field is selected: soft aqua-white. */
export const DEFAULT_RGB: [number, number, number] = hexToRgb("#8fe9dc");

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255,
  ];
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** aqua → sky → violet ramp for numeric fields. */
function ramp(t: number): [number, number, number] {
  const stops: [number, [number, number, number]][] = [
    [0, hexToRgb("#1fe0c4")],
    [0.5, hexToRgb("#37b6ff")],
    [1, hexToRgb("#7a5cff")],
  ];
  const x = Math.max(0, Math.min(1, t));
  for (let i = 1; i < stops.length; i++) {
    const [p1, c1] = stops[i]!;
    if (x <= p1) {
      const [p0, c0] = stops[i - 1]!;
      const span = p1 - p0 || 1;
      const f = (x - p0) / span;
      return [lerp(c0[0], c1[0], f), lerp(c0[1], c1[1], f), lerp(c0[2], c1[2], f)];
    }
  }
  return stops[stops.length - 1]![1];
}

export interface ColorResult {
  colors: Float32Array;
  /** Legend entries when the field is categorical (value → hex). Empty for numeric/none. */
  legend: { label: string; hex: string }[];
  kind: "none" | "categorical" | "numeric";
}

function isNumeric(values: FieldValue[]): boolean {
  let seen = 0;
  for (const v of values) {
    if (v === null || v === undefined) continue;
    if (typeof v !== "number") return false;
    seen++;
  }
  return seen > 0;
}

/** Build a color buffer for `count` points from one field's values. */
export function colorByField(values: FieldValue[], count: number): ColorResult {
  const colors = new Float32Array(count * 3);

  // No field selected → uniform brand color.
  if (values.length === 0) {
    for (let i = 0; i < count; i++) colors.set(DEFAULT_RGB, i * 3);
    return { colors, legend: [], kind: "none" };
  }

  if (isNumeric(values)) {
    let min = Infinity;
    let max = -Infinity;
    for (const v of values) {
      if (typeof v === "number") {
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    const span = max - min || 1;
    for (let i = 0; i < count; i++) {
      const v = values[i];
      const rgb = typeof v === "number" ? ramp((v - min) / span) : DEFAULT_RGB;
      colors.set(rgb, i * 3);
    }
    return { colors, legend: [], kind: "numeric" };
  }

  // Categorical: assign a hue per distinct value (by frequency, most common first).
  const freq = new Map<string, number>();
  for (const v of values) {
    const key = v === null || v === undefined ? "—" : String(v);
    freq.set(key, (freq.get(key) ?? 0) + 1);
  }
  const ordered = [...freq.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  const hueOf = new Map<string, string>();
  ordered.forEach((key, i) => hueOf.set(key, CATEGORICAL[i % CATEGORICAL.length]!));

  for (let i = 0; i < count; i++) {
    const v = values[i];
    const key = v === null || v === undefined ? "—" : String(v);
    colors.set(hexToRgb(hueOf.get(key) ?? "#8fe9dc"), i * 3);
  }

  const legend = ordered.slice(0, 10).map((label) => ({ label, hex: hueOf.get(label)! }));
  return { colors, legend, kind: "categorical" };
}
