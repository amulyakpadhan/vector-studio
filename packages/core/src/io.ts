import type { Json, VectorRecord } from "./types.ts";

/** File formats the studio can import from and export to. */
export type RecordFormat = "json" | "jsonl" | "csv";

export interface SerializeOpts {
  /** Include the `vector` field in the output. Off by default — vectors are large. */
  withVectors?: boolean;
}

/** Guess a format from a file name, defaulting to json. */
export function formatFromFilename(name: string): RecordFormat {
  const lower = name.toLowerCase();
  if (lower.endsWith(".jsonl") || lower.endsWith(".ndjson")) return "jsonl";
  if (lower.endsWith(".csv")) return "csv";
  return "json";
}

// ─── serialize ─────────────────────────────────────────────────────────────

export function serializeRecords(records: VectorRecord[], format: RecordFormat, opts: SerializeOpts = {}): string {
  const rows = opts.withVectors ? records : records.map((r) => ({ id: r.id, payload: r.payload }));
  switch (format) {
    case "json":
      return JSON.stringify(rows, null, 2);
    case "jsonl":
      return rows.map((r) => JSON.stringify(r)).join("\n");
    case "csv":
      return toCsv(records, opts.withVectors ?? false);
    default:
      throw new Error(`Unknown format "${format}"`);
  }
}

function toCsv(records: VectorRecord[], withVectors: boolean): string {
  const payloadKeys = new Set<string>();
  for (const r of records) for (const k of Object.keys(r.payload)) payloadKeys.add(k);
  const keys = [...payloadKeys];

  const header = ["id", ...keys, ...(withVectors ? ["vector"] : [])];
  const lines = [header.map(csvCell).join(",")];

  for (const r of records) {
    const cells: string[] = [String(r.id)];
    for (const k of keys) cells.push(cellFor(r.payload[k]));
    if (withVectors) cells.push(r.vector ? JSON.stringify(r.vector) : "");
    lines.push(cells.map(csvCell).join(","));
  }
  return lines.join("\n");
}

function cellFor(v: Json | undefined): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

/** Quote a CSV cell only when it needs it. */
function csvCell(s: string): string {
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

// ─── parse ───────────────────────────────────────────────────────────────────

export function parseRecords(text: string, format: RecordFormat): VectorRecord[] {
  switch (format) {
    case "json":
      return parseJsonArray(text);
    case "jsonl":
      return parseJsonl(text);
    case "csv":
      return parseCsv(text);
    default:
      throw new Error(`Unknown format "${format}"`);
  }
}

function parseJsonArray(text: string): VectorRecord[] {
  const data = JSON.parse(text) as unknown;
  if (!Array.isArray(data)) throw new Error("Expected a JSON array of records.");
  return data.map((row, i) => toRecord(row, i));
}

function parseJsonl(text: string): VectorRecord[] {
  const out: VectorRecord[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      throw new Error(`Line ${i + 1} is not valid JSON.`);
    }
    out.push(toRecord(row, i));
  }
  return out;
}

/** Coerce a parsed object into a VectorRecord, tolerating loose input. */
function toRecord(row: unknown, index: number): VectorRecord {
  if (typeof row !== "object" || row === null) {
    throw new Error(`Record ${index + 1} is not an object.`);
  }
  const obj = row as Record<string, unknown>;

  // id: accept id/_id/ID, else fall back to the row index.
  const rawId = obj.id ?? obj._id ?? obj.ID;
  const id: string | number =
    typeof rawId === "number" || typeof rawId === "string" ? rawId : index;

  const vector = coerceVector(obj.vector ?? obj.values ?? obj.embedding);

  // payload: an explicit `payload` object, or every remaining top-level key.
  let payload: Record<string, Json>;
  if (obj.payload && typeof obj.payload === "object" && !Array.isArray(obj.payload)) {
    payload = obj.payload as Record<string, Json>;
  } else {
    payload = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k === "id" || k === "_id" || k === "ID" || k === "vector" || k === "values" || k === "embedding") continue;
      payload[k] = v as Json;
    }
  }

  return vector ? { id, payload, vector } : { id, payload };
}

function coerceVector(v: unknown): number[] | undefined {
  if (Array.isArray(v) && v.every((n) => typeof n === "number")) return v as number[];
  return undefined;
}

// ─── CSV parsing ───────────────────────────────────────────────────────────

function parseCsv(text: string): VectorRecord[] {
  const rows = parseCsvRows(text);
  if (rows.length === 0) return [];
  const header = rows[0]!;
  const idCol = header.findIndex((h) => h === "id" || h === "_id" || h === "ID");
  const vectorCol = header.findIndex((h) => h === "vector" || h === "values" || h === "embedding");

  const out: VectorRecord[] = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r]!;
    if (cells.length === 1 && cells[0] === "") continue; // trailing blank line

    const rawId = idCol >= 0 ? cells[idCol] : undefined;
    const id: string | number = rawId != null && rawId !== "" ? coerceScalar(rawId) : r - 1;

    let vector: number[] | undefined;
    if (vectorCol >= 0 && cells[vectorCol]) {
      try {
        const parsed = JSON.parse(cells[vectorCol]!) as unknown;
        if (Array.isArray(parsed) && parsed.every((n) => typeof n === "number")) vector = parsed as number[];
      } catch {
        /* leave vector undefined */
      }
    }

    const payload: Record<string, Json> = {};
    for (let c = 0; c < header.length; c++) {
      if (c === idCol || c === vectorCol) continue;
      const key = header[c]!;
      const raw = cells[c];
      if (raw === undefined || raw === "") continue;
      payload[key] = coerceCell(raw);
    }

    out.push(vector ? { id, payload, vector } : { id, payload });
  }
  return out;
}

/** Number if it round-trips exactly, else the original string. */
function coerceScalar(s: string): string | number {
  if (s !== "" && !Number.isNaN(Number(s)) && String(Number(s)) === s) return Number(s);
  return s;
}

/** For payload cells: try JSON (objects, arrays, bools, numbers), else keep as string. */
function coerceCell(s: string): Json {
  const trimmed = s.trim();
  if (/^[[{]/.test(trimmed) || trimmed === "true" || trimmed === "false" || trimmed === "null") {
    try {
      return JSON.parse(trimmed) as Json;
    } catch {
      return s;
    }
  }
  const asNum = coerceScalar(s);
  return asNum;
}

/** RFC-4180-ish row splitter: handles quotes, escaped quotes, and newlines inside quotes. */
function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += ch;
    }
  }
  // flush the final cell/row if the file doesn't end in a newline
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}
