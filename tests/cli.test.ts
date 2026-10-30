import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { client } from "carina/client";
import shop, { type Shop } from "../examples/shop";
import { build } from "../src/cli";
import { Runtime } from "../src/runtime";

test("build type-checks the requested entry even when the parent project excludes it", async () => {
  const root = mkdtempSync(join(process.cwd(), ".carina-build-test-"));
  try {
    const entry = join(root, "index.ts");
    writeFileSync(entry, `import {service} from "carina";\nconst invalid: number = "bad";\nexport default service({name:"invalid",version:1,actors:{}});\n`);
    await expect(build(entry, join(root, "app"))).rejects.toThrow("Service type-check failed");
    expect(existsSync(join(root, "app"))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30_000);

test("standalone binary rolls back a SIGKILL midway through a delivery batch and preserves acknowledged commits", async () => {
  const root = mkdtempSync(join(tmpdir(), "carina-binary-"));
  const binary = join(root, "shop"), data = join(root, "data"), marker = join(root, "crash-once");
  const children: ReturnType<typeof Bun.spawn>[] = [];
  async function start() {
    const child = Bun.spawn([binary, "serve", "--data", data, "--port", "0"], { cwd: root, env: { ...process.env, CARINA_ACCESS_KEY: "secret", CARINA_TEST_CRASH_MARKER: marker, CARINA_TEST_CRASH_TARGET: "q" }, stdout: "pipe", stderr: "pipe" });
    children.push(child);
    const reader = child.stdout.getReader(); let text = "";
    try {
      while (!text.includes("\n")) { const chunk = await reader.read(); if (chunk.done) throw new Error(`Executable exited before ready: ${await new Response(child.stderr).text()}`); text += new TextDecoder().decode(chunk.value); }
    } finally { reader.releaseLock(); }
    const ready = text.split("\n").filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return {}; } }).find(line => line.ready);
    if (!ready) throw new Error(`Missing readiness message: ${text}`);
    return { child, api: client<Shop>({ url: ready.url, accessKey: "secret", retries: 0 }) };
  }
  try {
    await build("tests/crash-service.ts", binary);
    expect(existsSync(binary)).toBe(true);
    let runtime = new Runtime(shop, data);
    runtime.call("product", "p", "", { name: "Hiking Boot", stock: 10 }, "create-p", true);
    runtime.call("product", "q", "", { name: "Runner", stock: 10 }, "create-q", true);
    runtime.call("order", "o", "", { sku: "p", qty: 2, status: "new" }, "create-o", true);
    runtime.call("order", "second", "", { sku: "q", qty: 3, status: "new" }, "create-second", true);
    runtime.call("order", "o", "start", {}, "start");
    runtime.call("order", "second", "start", {}, "start-second"); runtime.close();
    writeFileSync(marker, "crash before receiver commit");
    const first = await start();
    await first.child.exited;
    expect(first.child.signalCode).toBe("SIGKILL");
    runtime = new Runtime(shop, data);
    // The first receiver turn finished its savepoint, but the second turn
    // killed the process before their shared durable commit.
    expect(JSON.parse((runtime.inspect("product", "p") as any).state).stock).toBe(10);
    expect(JSON.parse((runtime.inspect("product", "q") as any).state).stock).toBe(10);
    expect(runtime.messages("pending")).toHaveLength(2);
    expect(runtime.messages("processed")).toHaveLength(0); runtime.close();
    const second = await start();
    const watch = second.api.queries.orderStatus.watch({ key: "o" });
    try { for await (const rows of watch) { if (rows[0]?.status === "reserved") break; } } finally { await watch.return!(); }
    expect((await second.api.queries.catalog.query({ minStock: 0 }))[0]!.stock).toBe(8);
    expect((await second.api.queries.catalog.query({ minStock: 0 }))[1]!.stock).toBe(7);
    expect(await second.api.product("p").restock({ qty: 3 }, { idempotencyKey: "durable-restock" })).toEqual({ stock: 11 });
    // A second executable must respect the same directory lock across processes.
    const locked = Bun.spawn([binary, "inspect", "product/p", "--data", data], { cwd: root, stderr: "pipe", stdout: "pipe" });
    expect(await locked.exited).not.toBe(0);
    expect(await new Response(locked.stderr).text()).toContain("DirectoryLocked");
    second.child.kill("SIGKILL"); await second.child.exited;
    runtime = new Runtime(shop, data);
    expect(JSON.parse((runtime.inspect("product", "p") as any).state).stock).toBe(11);
    expect(runtime.messages("processed")).toHaveLength(4);
    expect(runtime.deliverOne()).toBe(false);
    expect(runtime.call("product", "p", "restock", { qty: 3 }, "durable-restock")).toEqual({ stock: 11 });
    runtime.close();
    const backup = join(root, "backup");
    const copied = Bun.spawn([binary, "backup", "--data", data, "--to", backup], { cwd: root, stdout: "pipe", stderr: "pipe" });
    expect(await copied.exited).toBe(0);
    runtime = new Runtime(shop, backup);
    expect(JSON.parse((runtime.inspect("product", "p") as any).state).stock).toBe(11); runtime.close();
  } finally {
    for (const child of children) { if (child.exitCode === null) child.kill(); await child.exited; }
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
