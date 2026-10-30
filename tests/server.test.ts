import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { client } from "carina/client";
import shop, { type Shop } from "../examples/shop";
import { serve } from "../src/server";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const run of cleanup.splice(0)) run(); });
function application() {
  const data = mkdtempSync(join(tmpdir(), "carina-server-"));
  const app = serve(shop, { data, accessKey: "test-key", port: 0 });
  cleanup.unshift(() => { app.close(); rmSync(data, { recursive: true, force: true }); });
  return { ...app, client: client<Shop>({ url: app.server.url.toString(), accessKey: "test-key", retries: 0 }) };
}
async function guarded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Observable result did not arrive")), 5000); })]); }
  finally { clearTimeout(timer!); }
}

test("1,000 concurrent reservations produce exactly 100 successes", async () => {
  const app = application();
  await app.client.product.create("sku-1", { name: "Hiking Boot", stock: 100 });
  const results = await Promise.allSettled(Array.from({ length: 1000 }, (_, i) => app.client.product("sku-1").reserve({ qty: 1 }, { idempotencyKey: `reserve-${i}` })));
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(100);
  const errors = results.filter(r => r.status === "rejected");
  expect(errors).toHaveLength(900);
  for (const error of errors) if (error.status === "rejected") expect(error.reason._tag).toBe("InsufficientStock");
  expect(await app.client.queries.catalog.query({ minStock: 0 })).toEqual([{ key: "sku-1", name: "Hiking Boot", stock: 0 }]);
}, 30_000);

test("watches deliver initial state and converge after writes; returning closes them", async () => {
  const app = application();
  await app.client.product.create("p/with spaces", { name: "Hiking Boot", stock: 0 });
  const watch = app.client.queries.catalog.watch({ minStock: 0 });
  cleanup.unshift(() => { void watch.return!(); });
  expect((await guarded(watch.next())).value).toEqual([{ key: "p/with spaces", name: "Hiking Boot", stock: 0 }]);
  await Promise.all(Array.from({ length: 25 }, () => app.client.product("p/with spaces").restock({ qty: 1 })));
  let latest;
  do { latest = (await guarded(watch.next())).value; } while (latest[0].stock !== 25);
  expect(latest[0].stock).toBe(25);
  await watch.return!(); expect((await watch.next()).done).toBe(true);
});

test("HTTP and WebSocket authentication, input errors, and internal visibility", async () => {
  const app = application(), url = app.server.url.toString();
  const bad = client<Shop>({ url, accessKey: "wrong" });
  await expect(bad.queries.catalog.query({ minStock: 0 })).rejects.toMatchObject({ _tag: "Unauthorized" });
  const watch = bad.queries.catalog.watch({ minStock: 0 });
  await expect(guarded(watch.next())).rejects.toMatchObject({ _tag: "Unauthorized" });
  await watch.return!();
  await app.client.product.create("p", { name: "Hiking Boot", stock: 10 });
  const response = await fetch(new URL("/v1/actors/product/p/actions/reserveForOrder", url), { method: "POST", headers: { authorization: "Bearer test-key", "content-type": "application/json" }, body: JSON.stringify({ qty: 1 }) });
  expect(response.status).toBe(404);
  await expect(app.client.product("p").reserve({ qty: -1 })).rejects.toMatchObject({ _tag: "InvalidInput" });
});

test("gateway returns 503 for a full queue while reads continue, then admits the same request", async () => {
  const app = application();
  await app.client.product.create("p", { name: "Hiking Boot", stock: 0 });
  await app.client.order.create("o", { sku: "p", qty: 1, status: "new" });
  // Invoke the gateway before its next flush; this makes saturation
  // deterministic without relying on network timing or replacing the writer.
  const accepted = Array.from({ length: 1024 }, (_, i) => app.runtime.submit("product", "p", "restock", { qty: 1 }, `fill-${i}`));
  const drained = Promise.all(accepted);
  const mutation = () => new Request(new URL("/v1/actors/order/o/actions/start", app.server.url), { method: "POST", headers: { authorization: "Bearer test-key", "content-type": "application/json", "idempotency-key": "retry-http" }, body: "{}" });
  try {
    const response = await app.server.fetch(mutation());
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { _tag: "Overloaded" } });
    const read = await app.server.fetch(new Request(new URL("/v1/queries/orderStatus", app.server.url), { method: "POST", headers: { authorization: "Bearer test-key", "content-type": "application/json" }, body: JSON.stringify({ key: "o" }) }));
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ result: [{ status: "new" }] });
    expect(app.runtime.db.query("SELECT 1 FROM receipts WHERE request_id='retry-http'").get()).toBeNull();
  } finally { await drained; }
  const retried = await fetch(mutation());
  expect(retried.status).toBe(200);
  expect(await retried.json()).toEqual({ reply: { status: "reserving" } });
});

test("durable reservation completes through HTTP and the order watch", async () => {
  const app = application();
  await app.client.product.create("p", { name: "Hiking Boot", stock: 10 });
  await app.client.order.create("o", { sku: "p", qty: 2, status: "new" });
  const watch = app.client.queries.orderStatus.watch({ key: "o" });
  cleanup.unshift(() => { void watch.return!(); });
  expect((await guarded(watch.next())).value).toEqual([{ status: "new" }]);
  await app.client.order("o").start({}, { idempotencyKey: "start" });
  let result;
  do { result = (await guarded(watch.next())).value; } while (result[0].status !== "reserved");
  expect(await app.client.queries.catalog.query({ minStock: 0 })).toEqual([{ key: "p", name: "Hiking Boot", stock: 8 }]);
  expect(app.runtime.messages("processed")).toHaveLength(2);
});

test("a watch reconnects and reads current state", async () => {
  const app = application();
  await app.client.product.create("p", { name: "Hiking Boot", stock: 1 });
  const watch = app.client.queries.catalog.watch({ minStock: 0 });
  cleanup.unshift(() => { void watch.return!(); });
  await guarded(watch.next());
  // Drop the actual transport, then commit while the client reconnects.
  (watch as any).socket.close();
  await app.client.product("p").restock({ qty: 3 });
  expect((await guarded(watch.next())).value[0].stock).toBe(4);
});

test("a lost response body retries the same request without repeating its effects", async () => {
  const app = application();
  await app.client.product.create("p", { name: "Hiking Boot", stock: 10 });
  const realFetch = globalThis.fetch.bind(globalThis), keys: (string | null)[] = [];
  const replacement = Object.assign(async (input: Parameters<typeof fetch>[0], options?: Parameters<typeof fetch>[1]) => {
    keys.push(new Headers(options?.headers).get("idempotency-key"));
    const response = await realFetch(input, options);
    if (keys.length === 1) {
      await response.body?.cancel();
      return new Response(new ReadableStream({ start(controller) { controller.error(new TypeError("Lost reply after commit")); } }));
    }
    return response;
  }, { preconnect: globalThis.fetch.preconnect });
  const mocked = spyOn(globalThis, "fetch").mockImplementation(replacement);
  try {
    const api = client<Shop>({ url: app.server.url.toString(), accessKey: "test-key", retries: 1 });
    expect(await api.product("p").reserve({ qty: 2 })).toEqual({ stock: 8 });
    expect(keys).toHaveLength(2); expect(keys[0]).toBe(keys[1]);
  } finally { mocked.mockRestore(); }
  expect(app.runtime.query("catalog", { minStock: 0 })).toEqual([{ key: "p", name: "Hiking Boot", stock: 8 }]);
});
