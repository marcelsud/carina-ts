import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { client } from "carina/client";
import shop, { type Shop } from "../examples/shop";
import { Runtime } from "../src/runtime";
import { serve } from "../src/server";

const round = (n: number) => Number(n.toFixed(3));
export async function benchmark(options: { mutations?: number; output?: string } = {}) {
  const count = options.mutations ?? 500;
  if (!Number.isSafeInteger(count) || count < 1) throw new Error("Benchmark mutation count must be a positive integer");
  const data = mkdtempSync(join(tmpdir(), "carina-bench-"));
  let runtime: Runtime | undefined, app: ReturnType<typeof serve> | undefined;
  async function bounded<T>(promise: Promise<T>) {
    let timer: ReturnType<typeof setTimeout>;
    try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Benchmark watch timed out")), 10_000); })]); }
    finally { clearTimeout(timer!); }
  }
  try {
  runtime = new Runtime(shop, data);
  runtime.call("product", "p", "", { name: "Hiking Boot", stock: 0 }, "create", true);
  const samples: number[] = [], start = performance.now();
  for (let i = 0; i < count; i++) {
    const before = performance.now();
    runtime.call("product", "p", "restock", { qty: 1 }, `bench-${i}`);
    samples.push(performance.now() - before);
  }
  const elapsed = performance.now() - start;
  assert.equal(JSON.parse((runtime.inspect("product", "p") as any).state).stock, count);
  runtime.close();
  const startup = performance.now(); runtime = new Runtime(shop, data);
  const startupMs = performance.now() - startup; runtime.close(); runtime = undefined;
  app = serve(shop, { data, accessKey: "benchmark", port: 0 });
  const api = client<Shop>({ url: app.server.url.toString(), accessKey: "benchmark" });
  const clients = Math.min(64, count), concurrentSamples: number[] = [];
  const concurrentStart = performance.now();
  await bounded(Promise.all(Array.from({ length: clients }, async (_, worker) => {
    for (let i = worker; i < count; i += clients) {
      const before = performance.now();
      await api.product("p").restock({ qty: 1 }, { idempotencyKey: `concurrent-${i}` });
      concurrentSamples.push(performance.now() - before);
    }
  })));
  const concurrentElapsed = performance.now() - concurrentStart;
  assert.equal((await api.queries.catalog.query({ minStock: 0 }))[0]!.stock, count * 2);
  concurrentSamples.sort((a, b) => a - b);
  const concurrent = { clients, mutations: count, actionsPerSecond: round(count * 1000 / concurrentElapsed), latencyMs: { p50: round(concurrentSamples[Math.floor(count * .5)]!), p99: round(concurrentSamples[Math.floor(count * .99)]!) } };
  const watches: { subscriptions: number; refreshMs: number }[] = [];
  let stock = count * 2;
  for (const subscriptions of [1, 10, 100]) {
    const active = Array.from({ length: subscriptions }, () => api.queries.catalog.watch({ minStock: 0 }));
    try {
      await bounded(Promise.all(active.map(watch => watch.next())));
      const pending = active.map(watch => watch.next()), before = performance.now();
      await api.product("p").restock({ qty: 1 }); stock++;
      const results = await bounded(Promise.all(pending));
      for (const result of results) assert.equal(result.value?.[0]?.stock, stock);
      watches.push({ subscriptions, refreshMs: round(performance.now() - before) });
    } finally { await Promise.all(active.map(watch => watch.return!())); }
  }
  samples.sort((a, b) => a - b);
  const report = { bun: Bun.version, platform: process.platform, arch: process.arch, storage: "temporary local directory, WAL, synchronous=FULL", mutations: count, actionsPerSecond: round(count * 1000 / elapsed), latencyMs: { p50: round(samples[Math.floor(count * .5)]!), p99: round(samples[Math.floor(count * .99)]!) }, concurrent, startupMs: round(startupMs), watches };
  if (options.output) await Bun.write(options.output, JSON.stringify(report, null, 2) + "\n");
  return report;
  } finally { app?.close(); runtime?.close(); rmSync(data, { recursive: true, force: true }); }
}
if (import.meta.main) console.log(JSON.stringify(await benchmark({ output: "benchmarks/local.json" }), null, 2));
