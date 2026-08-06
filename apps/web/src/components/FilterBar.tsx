"use client";

import { useState } from "react";
import {
  buildFilter,
  opSupported,
  FILTER_OPS,
  type DbEngine,
  type FilterCondition,
  type FilterOp,
  type Json,
  type SchemaField,
} from "@vyn/core";

interface Props {
  engine: DbEngine;
  /** Known payload fields (name + type) — offered as suggestions, and used to
   * type filter values correctly instead of guessing from the raw text (a
   * numeric-looking string like a "0901" HS code is still `text`, not a number). */
  fields?: SchemaField[];
  /** Called with the engine-native filter object (or undefined to clear). */
  onApply: (filter: Json | undefined) => void;
}

interface Row {
  field: string;
  op: FilterOp;
  value: string;
}

const EMPTY: Row = { field: "", op: "eq", value: "" };

export function FilterBar({ engine, fields, onApply }: Props) {
  const [rows, setRows] = useState<Row[]>([{ ...EMPTY }]);
  const [match, setMatch] = useState<"all" | "any">("all");
  const [active, setActive] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ops = FILTER_OPS.filter((o) => opSupported(engine, o.op));
  const fieldTypes = new Map((fields ?? []).map((f) => [f.name, f.type]));

  function set(i: number, patch: Partial<Row>) {
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  }
  function addRow() {
    setRows((rs) => [...rs, { ...EMPTY }]);
  }
  function removeRow(i: number) {
    setRows((rs) => (rs.length === 1 ? [{ ...EMPTY }] : rs.filter((_r, j) => j !== i)));
  }

  function apply() {
    setError(null);
    const conditions: FilterCondition[] = rows
      .filter((r) => r.field.trim() !== "" && r.value.trim() !== "")
      .map((r) => ({ field: r.field.trim(), op: r.op, value: coerce(r.op, r.value, fieldTypes.get(r.field.trim())) }));
    if (conditions.length === 0) {
      setActive(false);
      onApply(undefined);
      return;
    }
    try {
      const filter = buildFilter(engine, { match, conditions });
      setActive(true);
      onApply(filter);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function clear() {
    setRows([{ ...EMPTY }]);
    setActive(false);
    setError(null);
    onApply(undefined);
  }

  return (
    <div className="filter-bar">
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <span style={{ color: "var(--text-dim)", fontSize: 12.5 }}>Match</span>
        <select className="select" style={{ width: "auto" }} value={match} onChange={(e) => setMatch(e.target.value as "all" | "any")}>
          <option value="all">all</option>
          <option value="any">any</option>
        </select>
        <span style={{ color: "var(--text-dim)", fontSize: 12.5 }}>of these conditions</span>
        {active && <span className="filter-active">● filter on</span>}
      </div>

      {rows.map((r, i) => (
        <div key={i} className="filter-row">
          <input
            className="input"
            list="filter-fields"
            placeholder="field"
            value={r.field}
            onChange={(e) => set(i, { field: e.target.value })}
          />
          <select className="select" value={r.op} onChange={(e) => set(i, { op: e.target.value as FilterOp })}>
            {ops.map((o) => (
              <option key={o.op} value={o.op}>
                {o.label}
              </option>
            ))}
          </select>
          <input
            className="input"
            placeholder={r.op === "in" ? "a, b, c" : "value"}
            value={r.value}
            onChange={(e) => set(i, { value: e.target.value })}
            onKeyDown={(e) => e.key === "Enter" && apply()}
          />
          <button className="btn ghost sm" onClick={() => removeRow(i)} title="Remove">
            ✕
          </button>
        </div>
      ))}

      {fields && fields.length > 0 && (
        <datalist id="filter-fields">
          {fields.map((f) => (
            <option key={f.name} value={f.name} />
          ))}
        </datalist>
      )}

      {error && <div className="banner err" style={{ marginTop: 8 }}>{error}</div>}

      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <button className="btn ghost sm" onClick={addRow}>
          + condition
        </button>
        <div style={{ flex: 1 }} />
        {active && (
          <button className="btn ghost sm" onClick={clear}>
            Clear
          </button>
        )}
        <button className="btn sm primary" onClick={apply}>
          Apply filter
        </button>
      </div>
    </div>
  );
}

/**
 * Turn the raw text value into a typed Json value based on the operator and,
 * when known, the field's actual schema type — so a numeric-looking string
 * (an HS code, a zip code, an ID with a leading zero) stored as `text` isn't
 * silently sent as a number just because it happens to look like one.
 */
function coerce(op: FilterOp, raw: string, knownType?: string): Json {
  if (op === "in") return raw.split(",").map((s) => scalar(s.trim(), knownType));
  return scalar(raw.trim(), knownType);
}

function scalar(s: string, knownType?: string): Json {
  if (knownType === "text" || knownType === "geo") return s;
  if (knownType === "boolean") return s === "true";
  if (knownType === "number" || knownType === "integer") {
    const n = Number(s);
    return s !== "" && !Number.isNaN(n) ? n : s;
  }
  // Field type unknown (not in schema, e.g. an unindexed field) — best-effort guess from shape.
  if (s === "true") return true;
  if (s === "false") return false;
  if (s !== "" && !Number.isNaN(Number(s)) && /^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}
