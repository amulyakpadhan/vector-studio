import { ConnectorError } from "./connector.ts";
import type { DbEngine, Json } from "./types.ts";

/** Operators the universal filter model understands. */
export type FilterOp = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "in" | "contains";

export interface FilterCondition {
  field: string;
  op: FilterOp;
  /** Typed already: number/boolean/string, or an array for `in`. */
  value: Json;
}

export interface FilterSpec {
  /** "all" → AND, "any" → OR. */
  match: "all" | "any";
  conditions: FilterCondition[];
}

/** Human labels + which engines accept each operator (for building the UI). */
export const FILTER_OPS: { op: FilterOp; label: string }[] = [
  { op: "eq", label: "equals" },
  { op: "neq", label: "not equals" },
  { op: "gt", label: "greater than" },
  { op: "gte", label: "≥" },
  { op: "lt", label: "less than" },
  { op: "lte", label: "≤" },
  { op: "in", label: "in (any of)" },
  { op: "contains", label: "contains text" },
];

/** `contains` needs full-text support, which Pinecone/Chroma metadata filters lack. */
export function opSupported(engine: DbEngine, op: FilterOp): boolean {
  if ((engine === "pinecone" || engine === "chroma") && op === "contains") return false;
  return true;
}

/**
 * Translate the universal filter into the engine's native filter object.
 * Returns undefined when there are no conditions. The result is passed
 * through connectors untouched (Qdrant/Pinecone) or serialized to GraphQL
 * (Weaviate) — see each connector.
 */
export function buildFilter(engine: DbEngine, spec: FilterSpec): Json | undefined {
  const conditions = spec.conditions.filter((c) => c.field.trim() !== "");
  if (conditions.length === 0) return undefined;

  switch (engine) {
    case "qdrant":
      return qdrantFilter(spec.match, conditions);
    case "pinecone":
      return pineconeFilter(spec.match, conditions);
    case "chroma":
      // Chroma's metadata `where` is the same Mongo-style dialect as Pinecone.
      return pineconeFilter(spec.match, conditions, "chroma");
    case "weaviate":
      return weaviateWhere(spec.match, conditions);
    case "milvus":
      return milvusExpr(spec.match, conditions);
    default:
      throw new ConnectorError(`Filtering isn't supported for ${engine} yet.`, engine);
  }
}

// ─── Qdrant: { must | should: [ { key, match|range } ] } ─────────────────────

function qdrantFilter(match: "all" | "any", conditions: FilterCondition[]): Json {
  const clauses = conditions.map((c) => qdrantClause(c));
  return match === "all" ? { must: clauses } : { should: clauses };
}

function qdrantClause(c: FilterCondition): Json {
  switch (c.op) {
    case "eq":
      return { key: c.field, match: { value: c.value } };
    case "neq":
      return { key: c.field, match: { except: [c.value] } };
    case "in":
      return { key: c.field, match: { any: asArray(c.value) } };
    case "contains":
      return { key: c.field, match: { text: c.value } };
    case "gt":
      return { key: c.field, range: { gt: c.value } };
    case "gte":
      return { key: c.field, range: { gte: c.value } };
    case "lt":
      return { key: c.field, range: { lt: c.value } };
    case "lte":
      return { key: c.field, range: { lte: c.value } };
  }
}

// ─── Pinecone: MongoDB-style metadata filter ─────────────────────────────────

const PINECONE_OP: Partial<Record<FilterOp, string>> = {
  eq: "$eq",
  neq: "$ne",
  gt: "$gt",
  gte: "$gte",
  lt: "$lt",
  lte: "$lte",
  in: "$in",
};

function pineconeFilter(match: "all" | "any", conditions: FilterCondition[], engine: DbEngine = "pinecone"): Json {
  const clauses = conditions.map((c) => pineconeClause(c, engine));
  if (clauses.length === 1) return clauses[0]!;
  return match === "all" ? { $and: clauses } : { $or: clauses };
}

function pineconeClause(c: FilterCondition, engine: DbEngine): Json {
  if (c.op === "contains") {
    throw new ConnectorError(`${engine} metadata filters can't do text \`contains\`.`, engine);
  }
  const op = PINECONE_OP[c.op]!;
  const value = c.op === "in" ? asArray(c.value) : c.value;
  return { [c.field]: { [op]: value } };
}

// ─── Weaviate: GraphQL `where` object (serialized to literal in the connector) ─

const WEAVIATE_OP: Partial<Record<FilterOp, string>> = {
  eq: "Equal",
  neq: "NotEqual",
  gt: "GreaterThan",
  gte: "GreaterThanEqual",
  lt: "LessThan",
  lte: "LessThanEqual",
  contains: "Like",
};

function weaviateWhere(match: "all" | "any", conditions: FilterCondition[]): Json {
  const operands = conditions.map((c) => weaviateOperand(c));
  if (operands.length === 1) return operands[0]!;
  return { operator: match === "all" ? "And" : "Or", operands };
}

function weaviateOperand(c: FilterCondition): Json {
  if (c.op === "in") {
    // expand to an Or of Equals over the values
    const operands = asArray(c.value).map((v) => ({ path: [c.field], operator: "Equal", ...weaviateValue(v) }));
    return operands.length === 1 ? operands[0]! : { operator: "Or", operands };
  }
  const operator = WEAVIATE_OP[c.op]!;
  const value = c.op === "contains" ? `*${String(c.value)}*` : c.value;
  return { path: [c.field], operator, ...weaviateValue(value) };
}

/** Weaviate types its where values by field name (valueText/valueInt/…). */
function weaviateValue(v: Json): Record<string, Json> {
  if (typeof v === "boolean") return { valueBoolean: v };
  if (typeof v === "number") return Number.isInteger(v) ? { valueInt: v } : { valueNumber: v };
  return { valueText: String(v) };
}

function asArray(v: Json): Json[] {
  return Array.isArray(v) ? v : [v];
}

// ─── Milvus: boolean expression string (not JSON) ────────────────────────────

const MILVUS_CMP: Partial<Record<FilterOp, string>> = {
  eq: "==",
  neq: "!=",
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
};

function milvusExpr(match: "all" | "any", conditions: FilterCondition[]): Json {
  const joiner = match === "all" ? " && " : " || ";
  return conditions.map((c) => `(${milvusClause(c)})`).join(joiner);
}

function milvusClause(c: FilterCondition): string {
  if (c.op === "in") {
    return `${c.field} in [${asArray(c.value).map(milvusValue).join(", ")}]`;
  }
  if (c.op === "contains") {
    return `${c.field} like ${milvusValue(`%${String(c.value)}%`)}`;
  }
  return `${c.field} ${MILVUS_CMP[c.op]} ${milvusValue(c.value)}`;
}

function milvusValue(v: Json): string {
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  return JSON.stringify(String(v)); // double-quoted + escaped
}
