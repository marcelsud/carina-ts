import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

test("dev restarts the application when its service source changes", async () => {
  const root = mkdtempSync(join(process.cwd(), "examples/.carina-dev-test-"));
  const entry = join(root, "index.ts");
  const source = (version: number) => `import {query,service} from "carina";\nexport default service({name:"dev-test",version:1,actors:{},queries:{value:query({},()=>({version:${version}}))}});\n`;
  writeFileSync(entry, source(1));
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = probe.port!; probe.stop(true);
  const child = Bun.spawn([process.execPath, "src/cli.ts", "dev", entry, "--data", join(root, "data"), "--port", String(port)], { env: { ...process.env, CARINA_ACCESS_KEY: "dev-test-key" }, stdout: "pipe", stderr: "pipe" });
  async function untilVersion(version: number) {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/v1/queries/value`, { method: "POST", headers: { authorization: "Bearer dev-test-key", "content-type": "application/json" }, body: "{}" });
        const body = await response.json() as any;
        if (body.result?.version === version) return body.result;
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`Development server did not reach source version ${version}`);
  }
  try {
    expect(await untilVersion(1)).toEqual({ version: 1 });
    writeFileSync(entry, source(2));
    expect(await untilVersion(2)).toEqual({ version: 2 });
  } finally {
    child.kill("SIGTERM"); await child.exited;
    rmSync(root, { recursive: true, force: true });
  }
}, 25_000);
