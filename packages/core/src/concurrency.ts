/**
 * Map over `items` running at most `concurrency` calls of `fn` at once, in
 * result order. Building a collection list fires a stats/count call per
 * collection; a plain Promise.all(map(...)) launches ALL of them at once,
 * opening one connection per call regardless of pooling — a thundering herd
 * that hangs the sidebar and can overwhelm a self-hosted server. Bounding the
 * concurrency keeps the burst small (and is usually faster overall from less
 * contention) while still parallelizing.
 */
export async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const limit = Math.max(1, Math.min(concurrency, items.length));

  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  }

  await Promise.all(Array.from({ length: limit }, () => worker()));
  return results;
}
