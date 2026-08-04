import { test } from "node:test";
import assert from "node:assert/strict";
import { serializeRecords, parseRecords, formatFromFilename } from "../src/io.ts";
import type { VectorRecord } from "../src/types.ts";

const SAMPLE: VectorRecord[] = [
  { id: 1, payload: { title: "trail shoe", price: 120, tags: ["run", "trail"] }, vector: [0.1, 0.2] },
  { id: "abc", payload: { title: 'road, "fast"', price: 90 }, vector: [0.3, 0.4] },
];

test("formatFromFilename recognizes extensions", () => {
  assert.equal(formatFromFilename("data.json"), "json");
  assert.equal(formatFromFilename("data.jsonl"), "jsonl");
  assert.equal(formatFromFilename("data.ndjson"), "jsonl");
  assert.equal(formatFromFilename("data.csv"), "csv");
  assert.equal(formatFromFilename("noext"), "json");
});

test("json round-trips records without vectors by default", () => {
  const text = serializeRecords(SAMPLE, "json");
  const parsed = parseRecords(text, "json");
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0]!.vector, undefined);
  assert.deepEqual(parsed[0]!.payload, SAMPLE[0]!.payload);
  assert.equal(parsed[1]!.id, "abc");
});

test("json includes vectors when asked and round-trips them", () => {
  const text = serializeRecords(SAMPLE, "json", { withVectors: true });
  const parsed = parseRecords(text, "json");
  assert.deepEqual(parsed[0]!.vector, [0.1, 0.2]);
  assert.deepEqual(parsed[1]!.vector, [0.3, 0.4]);
});

test("jsonl emits one object per line and round-trips", () => {
  const text = serializeRecords(SAMPLE, "jsonl", { withVectors: true });
  assert.equal(text.split("\n").length, 2);
  const parsed = parseRecords(text, "jsonl");
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed[0]!.vector, [0.1, 0.2]);
});

test("jsonl reports the offending line on bad JSON", () => {
  assert.throws(
    () => parseRecords('{"id":1,"payload":{}}\nnot json', "jsonl"),
    /Line 2 is not valid JSON/,
  );
});

test("csv quotes cells with commas and quotes, and round-trips payload", () => {
  const text = serializeRecords(SAMPLE, "csv");
  // the payload string road, "fast" must survive quoting
  assert.match(text, /"road, ""fast"""/);
  const parsed = parseRecords(text, "csv");
  assert.equal(parsed.length, 2);
  assert.equal(parsed[1]!.payload.title, 'road, "fast"');
  assert.equal(parsed[0]!.payload.price, 120);
  assert.deepEqual(parsed[0]!.payload.tags, ["run", "trail"]);
});

test("csv carries vectors when withVectors is set", () => {
  const text = serializeRecords(SAMPLE, "csv", { withVectors: true });
  const parsed = parseRecords(text, "csv");
  assert.deepEqual(parsed[0]!.vector, [0.1, 0.2]);
});

test("csv preserves string ids that look non-numeric and coerces numeric ones", () => {
  const parsed = parseRecords("id,name\n42,alice\nu_7,bob", "csv");
  assert.equal(parsed[0]!.id, 42);
  assert.equal(parsed[1]!.id, "u_7");
});

test("parse tolerates flat objects with top-level fields as payload", () => {
  const parsed = parseRecords('[{"id":5,"title":"hi","vector":[1,2]}]', "json");
  assert.equal(parsed[0]!.id, 5);
  assert.deepEqual(parsed[0]!.payload, { title: "hi" });
  assert.deepEqual(parsed[0]!.vector, [1, 2]);
});

test("parse accepts alternate id/vector field names", () => {
  const parsed = parseRecords('[{"_id":"x","embedding":[0.5],"foo":"bar"}]', "json");
  assert.equal(parsed[0]!.id, "x");
  assert.deepEqual(parsed[0]!.vector, [0.5]);
  assert.deepEqual(parsed[0]!.payload, { foo: "bar" });
});

test("parse falls back to row index when id is missing", () => {
  const parsed = parseRecords('[{"title":"a"},{"title":"b"}]', "json");
  assert.equal(parsed[0]!.id, 0);
  assert.equal(parsed[1]!.id, 1);
});

test("csv handles quoted newlines inside a cell", () => {
  const parsed = parseRecords('id,note\n1,"line one\nline two"', "csv");
  assert.equal(parsed[0]!.payload.note, "line one\nline two");
});
