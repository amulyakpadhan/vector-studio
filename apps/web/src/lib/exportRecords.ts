import { serializeRecords, type RecordFormat, type VectorConnector, type VectorRecord } from "@vyn/core";

/** Hard cap so a stray "export" on a huge collection can't hang the browser. */
const MAX_RECORDS = 50_000;
const PAGE = 500;

/**
 * Page through an entire collection and return every record. When
 * `withVectors` is set it uses the connector's bulk vector fetch; otherwise
 * it scrolls payloads only, which is much cheaper.
 */
export async function collectAll(
  connector: VectorConnector,
  collection: string,
  withVectors: boolean,
): Promise<VectorRecord[]> {
  const out: VectorRecord[] = [];
  let cursor: string | undefined;

  if (withVectors) {
    for (;;) {
      const sample = await connector.fetchVectors(collection, { limit: PAGE, cursor });
      for (let i = 0; i < sample.ids.length; i++) {
        out.push({ id: sample.ids[i]!, payload: sample.payloads[i] ?? {}, vector: sample.vectors[i] });
      }
      if (!sample.nextCursor || out.length >= MAX_RECORDS) break;
      cursor = sample.nextCursor;
    }
  } else {
    for (;;) {
      const page = await connector.listRecords(collection, { limit: PAGE, cursor });
      out.push(...page.items);
      if (!page.nextCursor || out.length >= MAX_RECORDS) break;
      cursor = page.nextCursor;
    }
  }
  return out.slice(0, MAX_RECORDS);
}

const MIME: Record<RecordFormat, string> = {
  json: "application/json",
  jsonl: "application/x-ndjson",
  csv: "text/csv",
};

/** Fetch the whole collection, serialize, and trigger a browser download. */
export async function exportCollection(
  connector: VectorConnector,
  collection: string,
  format: RecordFormat,
  withVectors: boolean,
): Promise<number> {
  const records = await collectAll(connector, collection, withVectors);
  const text = serializeRecords(records, format, { withVectors });
  const blob = new Blob([text], { type: MIME[format] });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${collection}.${format}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return records.length;
}
