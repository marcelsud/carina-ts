import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { actor, action, query, service, upgrade, type Service } from "carina";
import shop from "../examples/shop";
import { Runtime } from "../src/runtime";

const cleanup: (() => void)[] = [];
function directory() { const path = mkdtempSync(join(tmpdir(), "carina-test-")); cleanup.unshift(() => rmSync(path, { recursive: true, force: true })); return path; }
function open(definition: Service = shop, path = directory(), maintenance = false) { const runtime = new Runtime(definition, path, { maintenance }); cleanup.unshift(() => runtime.close()); return runtime; }
function create(runtime: Runtime, type: string, key: string, input: unknown) { return runtime.call(type, key, "", input, `create-${type}-${key}`, true); }
function state(runtime: Runtime, type: string, key: string) { return JSON.parse((runtime.inspect(type, key) as any).state); }
function message(runtime: Runtime, id: string) { return runtime.db.query("SELECT *,CAST(id AS TEXT) AS id FROM messages WHERE id=?").get(id) as any; }
function tag(run: () => unknown, expected: string) { let caught: any; try { run(); } catch (e) { caught = e; } expect(caught?._tag).toBe(expected); }
afterEach(() => { for (const run of cleanup.splice(0)) run(); });

test("sender and receiver commits survive restart; internal delivery ignores receipt expiry", () => {
  const path = directory(); let runtime = open(shop, path);
  create(runtime, "product", "p", { name: "Hiking Boot", stock: 10 });
  create(runtime, "order", "o", { sku: "p", qty: 2, status: "new" });
  expect(runtime.call("order", "o", "start", {}, "start")).toEqual({ status: "reserving" });
  runtime.call("order", "o", "start", {}, "start");
  expect(runtime.messages()).toHaveLength(1);
  tag(() => runtime.call("order", "o", "start", { extra: true }, "start"), "InvalidInput");
  runtime.close(); runtime = open(shop, path);
  expect(runtime.deliverOne()).toBe(true);
  expect(state(runtime, "product", "p").stock).toBe(8);
  expect(runtime.messages("processed")).toHaveLength(1);
  expect(runtime.messages("pending")).toHaveLength(1);
  runtime.db.exec("DELETE FROM receipts");
  runtime.close(); runtime = open(shop, path);
  while (runtime.deliverOne()) {}
  expect(state(runtime, "order", "o").status).toBe("reserved");
  expect(state(runtime, "product", "p").stock).toBe(8);
  expect(runtime.messages("processed")).toHaveLength(2);
  expect(runtime.deliverOne()).toBe(false);
});

test("business rejection is a successfully delivered response", () => {
  const runtime = open();
  create(runtime, "product", "p", { name: "Hiking Boot", stock: 0 });
  create(runtime, "order", "o", { sku: "p", qty: 2, status: "new" });
  runtime.call("order", "o", "start", {}, "start");
  while (runtime.deliverOne()) {}
  expect(state(runtime, "order", "o").status).toBe("rejected");
  expect(runtime.messages("failed")).toHaveLength(0);
  expect(runtime.messages("processed")).toHaveLength(2);
});

test("a receiver failure discards state changes and response messages together", () => {
  const original = shop.actors.product.internal.reserveForOrder;
  const broken = service({ ...shop, actors: { ...shop.actors, product: { ...shop.actors.product,
    internal: { reserveForOrder: { ...original, run(context: any, input: any): null {
      original.run(context, input);
      throw new Error("Receiver failed after buffering its response");
    } } },
  } } });
  const runtime = open(broken);
  create(runtime, "product", "p", { name: "Hiking Boot", stock: 10 });
  create(runtime, "order", "o", { sku: "p", qty: 2, status: "new" });
  runtime.call("order", "o", "start", {}, "start");
  expect(runtime.deliverOne()).toBe(true);
  expect(state(runtime, "product", "p").stock).toBe(10);
  expect(runtime.messages()).toHaveLength(1);
  expect(runtime.messages("failed")).toHaveLength(1);
  expect(runtime.messages("processed")).toHaveLength(0);
});

test("failed and invalid actions roll back state, receipts and buffered sends", () => {
  const State = Schema.Struct({ n: Schema.Int });
  const broken = actor(State)({ actions: {
    throws: action({}, ({ state, send }) => { state.n++; send.product("p").reserveForOrder({ qty: 1 }); throw new Error("rollback"); }),
    invalid: action({}, ({ state }) => { (state as any).n = "invalid"; return null; }),
    reply: action({}, ({ state }) => { state.n++; return 1n; }),
  } });
  const runtime = open(service({ name: "shop", version: 1, actors: { ...shop.actors, broken } }));
  create(runtime, "broken", "b", { n: 0 });
  for (const name of ["throws", "invalid", "reply"]) tag(() => runtime.call("broken", "b", name, {}, name), "ActionFailed");
  expect(state(runtime, "broken", "b")).toEqual({ n: 0 });
  expect(runtime.messages()).toHaveLength(0);
  expect((runtime.db.query("SELECT count(*) AS n FROM receipts").get() as any).n).toBe(1);
});

test("input validation, declared errors and idempotency conflicts", () => {
  const runtime = open(); create(runtime, "product", "p", { name: "Hiking Boot", stock: 2 });
  expect(runtime.call("product", "p", "reserve", { qty: 1 }, "same")).toEqual({ stock: 1 });
  expect(runtime.call("product", "p", "reserve", { qty: 1 }, "same")).toEqual({ stock: 1 });
  tag(() => runtime.call("product", "p", "reserve", { qty: 2 }, "same"), "IdempotencyConflict");
  tag(() => runtime.call("product", "p", "reserve", { qty: 0 }, "invalid"), "InvalidInput");
  tag(() => runtime.call("product", "p", "reserve", { qty: 2 }, "no-stock"), "InsufficientStock");
  expect(state(runtime, "product", "p").stock).toBe(1);
});

test("queued calls isolate failures, deduplicate requests and notify after the shared commit", async () => {
  const runtime = open(); create(runtime, "product", "p", { name: "Hiking Boot", stock: 10 });
  const observed: { inTransaction: boolean; stock: number }[] = [];
  runtime.onCommit(() => observed.push({ inTransaction: runtime.db.inTransaction, stock: (runtime.query("catalog", { minStock: 0 }) as any)[0].stock }));
  const results = await Promise.allSettled([
    runtime.submit("product", "p", "reserve", { qty: 1 }, "reserve"),
    runtime.submit("product", "p", "reserve", { qty: 100 }, "rejected"),
    runtime.submit("product", "p", "restock", { qty: 2 }, "restock"),
    runtime.submit("product", "p", "reserve", { qty: 1 }, "reserve"),
  ]);
  expect(results[0]).toEqual({ status: "fulfilled", value: { stock: 9 } });
  expect(results[1]).toMatchObject({ status: "rejected", reason: { _tag: "InsufficientStock" } });
  expect(results[2]).toEqual({ status: "fulfilled", value: { stock: 11 } });
  expect(results[3]).toEqual(results[0]);
  expect(observed).toEqual([{ inTransaction: false, stock: 11 }]);
  expect(state(runtime, "product", "p").stock).toBe(11);
});

test("bounded queue rejects excess mutations without effects and accepts a retry after draining", async () => {
  const runtime = open();
  create(runtime, "product", "p", { name: "Hiking Boot", stock: 0 });
  create(runtime, "order", "o", { sku: "p", qty: 1, status: "new" });
  const accepted = Array.from({ length: 1024 }, (_, i) => runtime.submit("product", "p", "restock", { qty: 1 }, `fill-${i}`));
  const drained = Promise.all(accepted);
  try {
    await expect(runtime.submit("order", "o", "start", {}, "retry-start")).rejects.toMatchObject({ _tag: "Overloaded", status: 503 });
    await expect(runtime.submit("order", "new", "", { sku: "p", qty: 1, status: "new" }, "retry-create", true)).rejects.toMatchObject({ _tag: "Overloaded", status: 503 });
    expect(state(runtime, "order", "o").status).toBe("new");
    expect(runtime.messages()).toHaveLength(0);
    expect(runtime.db.query("SELECT 1 FROM receipts WHERE request_id IN ('retry-start','retry-create')").get()).toBeNull();
    tag(() => runtime.inspect("order", "new"), "NotFound");
  } finally { await drained; }
  expect(state(runtime, "product", "p").stock).toBe(1024);
  expect(await runtime.submit("order", "o", "start", {}, "retry-start")).toEqual({ status: "reserving" });
  expect(runtime.messages("pending")).toHaveLength(1);
  expect(await runtime.submit("order", "new", "", { sku: "p", qty: 1, status: "new" }, "retry-create", true)).toEqual({ key: "new" });
});

test("an outer COMMIT failure rejects the entire group and rolls back state and sends", async () => {
  let database: Runtime["db"];
  const bad = actor(Schema.Struct({ n: Schema.Int }))({ actions: {
    failCommit: action({}, () => { database.exec("INSERT INTO commit_child VALUES (123)"); return null; }),
  } });
  const runtime = open(service({ ...shop, actors: { ...shop.actors, bad } }));
  database = runtime.db;
  create(runtime, "order", "o", { sku: "p", qty: 1, status: "new" });
  create(runtime, "bad", "b", { n: 0 });
  database.exec("PRAGMA foreign_keys=ON; CREATE TABLE commit_parent(id INTEGER PRIMARY KEY); CREATE TABLE commit_child(id INTEGER REFERENCES commit_parent(id) DEFERRABLE INITIALLY DEFERRED)");
  let notifications = 0; runtime.onCommit(() => notifications++);
  const results = await Promise.allSettled([
    runtime.submit("order", "o", "start", {}, "start"),
    runtime.submit("bad", "b", "failCommit", {}, "fail-commit"),
  ]);
  for (const result of results) expect(result).toMatchObject({ status: "rejected", reason: { _tag: "ActionFailed" } });
  expect(notifications).toBe(0);
  expect(state(runtime, "order", "o").status).toBe("new");
  expect(runtime.messages()).toHaveLength(0);
  expect(database.query("SELECT 1 FROM receipts WHERE request_id='start'").get()).toBeNull();
  expect(await runtime.submit("order", "o", "start", {}, "start")).toEqual({ status: "reserving" });
  expect(notifications).toBe(1);
});

test("closing before a queued call commits rejects it and preserves stored state", async () => {
  const path = directory(), runtime = open(shop, path);
  create(runtime, "product", "p", { name: "Hiking Boot", stock: 10 });
  const pending = runtime.submit("product", "p", "restock", { qty: 1 }, "uncommitted");
  runtime.close();
  await expect(pending).rejects.toMatchObject({ _tag: "ActionFailed" });
  expect(state(open(shop, path), "product", "p").stock).toBe(10);
});

test("dispatcher groups committed messages and defers newly emitted responses to the next commit", async () => {
  const runtime = open(), orders = 70;
  create(runtime, "product", "p", { name: "Hiking Boot", stock: orders });
  for (let i = 0; i < orders; i++) {
    create(runtime, "order", String(i), { sku: "p", qty: 1, status: "new" });
    runtime.call("order", String(i), "start", {}, `start-${i}`);
  }
  const snapshots: { parents: number; responses: number; pendingResponses: number }[] = [];
  let timer: ReturnType<typeof setTimeout>;
  const finished = new Promise<void>((resolve, reject) => {
    timer = setTimeout(() => reject(new Error("Messages did not complete")), 5000);
    runtime.onCommit(() => {
      const rows = runtime.db.query("SELECT action,status,count(*) AS n FROM messages GROUP BY action,status").all() as any[];
      const count = (action: string, status: string) => rows.find(row => row.action === action && row.status === status)?.n ?? 0;
      const snapshot = { parents: count("reserveForOrder", "processed"), responses: count("reservationResult", "processed"), pendingResponses: count("reservationResult", "pending") };
      snapshots.push(snapshot);
      if (snapshot.responses === orders) resolve();
    });
  });
  runtime.startDispatch();
  try { await finished; } finally { clearTimeout(timer!); }
  expect(snapshots[0]!.parents).toBeGreaterThan(0);
  expect(snapshots[0]!.responses).toBe(0);
  expect(snapshots[0]!.pendingResponses).toBe(snapshots[0]!.parents);
  expect(runtime.messages("processed")).toHaveLength(orders * 2);
  expect(state(runtime, "product", "p").stock).toBe(0);
});

test("failed messages retry with the same ID; archived messages remain terminal", () => {
  const runtime = open(); create(runtime, "order", "o", { sku: "missing", qty: 1, status: "new" });
  runtime.call("order", "o", "start", {}, "start");
  expect(runtime.deliverOne()).toBe(true);
  const failed = runtime.messages("failed")[0] as any;
  expect(JSON.parse(failed.error)._tag).toBe("NotFound");
  create(runtime, "product", "missing", { name: "Hiking Boot", stock: 3 });
  runtime.retry(failed.id);
  while (runtime.deliverOne()) {}
  expect(state(runtime, "product", "missing").stock).toBe(2);
  expect(message(runtime, failed.id).attempts).toBe(2);
  runtime.archive(failed.id, "Completed");
  expect(message(runtime, failed.id).processed_at).toBeNumber();
  tag(() => runtime.retry(failed.id), "InvalidInput");
  create(runtime, "order", "abandoned", { sku: "missing", qty: 1, status: "new" });
  runtime.call("order", "abandoned", "start", {}, "abandon");
  const pending = runtime.messages("pending")[0] as any;
  runtime.archive(pending.id, "Cancelled");
  expect(runtime.deliverOne()).toBe(false);
  expect(state(runtime, "product", "missing").stock).toBe(2);
});

const V1 = Schema.Struct({ name: Schema.String, stock: Schema.Int });
const V2 = Schema.Struct({ ...V1.fields, category: Schema.String });
function versioned(current: boolean, bad = false) {
  return service({ name: "versioned", version: 1, actors: { product: actor({ state: current ? V2 : V1,
    upgrades: current ? [upgrade(V1, V2, old => { if (bad && old.name === "bad") throw new Error("bad row"); return { ...old, category: "general" }; })] : [],
    actions: { restock: action({ qty: Schema.Int }, ({ state }, { qty }) => { state.stock += qty; return null; }) },
  }) }, queries: { categories: query({ category: Schema.String }, ({ db }, { category }) => db.all(Schema.Struct({ key: Schema.String, category: Schema.String }),
    `SELECT key,json_extract(state,'$.category') AS category FROM actors WHERE json_extract(state,'$.category')=? ORDER BY key`, [category])) } });
}

test("logical views upgrade before filtering, preserve storage on reads and persist on actions", () => {
  const path = directory(); let runtime = open(versioned(false), path);
  create(runtime, "product", "p", { name: "Runner", stock: 2 }); runtime.close();
  runtime = open(versioned(true), path);
  expect(runtime.query("categories", { category: "general" })).toEqual([{ key: "p", category: "general" }]);
  expect((runtime.inspect("product", "p") as any).state_version).toBe(0);
  runtime.call("product", "p", "restock", { qty: 1 }, "restock");
  expect((runtime.inspect("product", "p") as any).state_version).toBe(1);
  expect(state(runtime, "product", "p")).toEqual({ name: "Runner", stock: 3, category: "general" });
  runtime.close(); tag(() => open(versioned(false), path), "CompatibilityError");
});

test("a failed bulk migration preserves all row versions; corrected migration completes", () => {
  const path = directory(); let runtime = open(versioned(false), path);
  create(runtime, "product", "a", { name: "good", stock: 1 });
  create(runtime, "product", "b", { name: "bad", stock: 1 }); runtime.close();
  runtime = open(versioned(true, true), path, true);
  tag(() => runtime.query("categories", { category: "general" }), "UpgradeFailed");
  tag(() => runtime.migrate(), "UpgradeFailed");
  expect((runtime.inspect("product", "a") as any).state_version).toBe(0);
  expect((runtime.inspect("product", "b") as any).state_version).toBe(0);
  runtime.close(); runtime = open(versioned(true), path, true); runtime.migrate();
  expect((runtime.inspect("product", "a") as any).state_version).toBe(1);
  expect((runtime.inspect("product", "b") as any).state_version).toBe(1);
});

test("queued contracts are checked; explicit storage migration can transform queued inputs", () => {
  const path = directory(); let runtime = open(shop, path);
  create(runtime, "order", "o", { sku: "p", qty: 1, status: "new" });
  runtime.call("order", "o", "start", {}, "start"); runtime.close();
  const changed = service({ ...shop, actors: { ...shop.actors, product: { ...shop.actors.product, internal: {
    reserveForOrder: action({ qty: Schema.Int, reason: Schema.String }, () => null),
  } } } });
  tag(() => open(changed, path), "CompatibilityError");
  const migrated = service({ ...changed, version: 2, migrations: [{ from: 1, to: 2, run(db) {
    db.exec(`UPDATE messages SET input=json_set(input,'$.reason','upgrade') WHERE status='pending'`);
  } }] });
  runtime = open(migrated, path, true); runtime.migrate(); runtime.close();
  runtime = open(migrated, path);
  expect(runtime.messages("pending")).toHaveLength(1);
});

test("exclusive directory lock releases on close", () => {
  const path = directory(), runtime = open(shop, path);
  tag(() => open(shop, path), "DirectoryLocked"); runtime.close();
  expect(open(shop, path)).toBeInstanceOf(Runtime);
});

test("backup preserves actor states, receipts and pending messages", async () => {
  const runtime = open(), destination = directory();
  create(runtime, "product", "p", { name: "Hiking Boot", stock: 3 });
  create(runtime, "order", "o", { sku: "p", qty: 1, status: "new" });
  runtime.call("order", "o", "start", {}, "start");
  await runtime.backup(destination);
  const restored = open(shop, destination);
  expect(restored.call("order", "o", "start", {}, "start")).toEqual({ status: "reserving" });
  while (restored.deliverOne()) {}
  expect(state(restored, "product", "p").stock).toBe(2);
  expect(state(restored, "order", "o").status).toBe("reserved");
});
