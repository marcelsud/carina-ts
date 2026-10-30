#!/usr/bin/env bun
import { existsSync, mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL, fileURLToPath } from "node:url";
import type { Service } from "./index";
import { Runtime } from "./runtime";
import { serve } from "./server";

function argumentsFor(args: string[]) {
  return parseArgs({ args, allowPositionals: true, options: {
    data: { type: "string", default: "./data" }, host: { type: "string", default: "127.0.0.1" },
    port: { type: "string", default: "7070" }, out: { type: "string" }, to: { type: "string" },
    status: { type: "string" }, reason: { type: "string" },
  } });
}
export async function runApplication(service: Service, args = Bun.argv.slice(2)) {
  const { values, positionals } = argumentsFor(args);
  const command = positionals[0] ?? "serve";
  if (command === "serve") {
    const application = serve(service, { data: values.data!, host: values.host, port: Number(values.port), accessKey: process.env.CARINA_ACCESS_KEY ?? "" });
    console.log(JSON.stringify({ ready: true, service: service.name, url: application.server.url.toString() }));
    const stop = () => { application.close(); process.exit(0); };
    process.once("SIGTERM", stop); process.once("SIGINT", stop);
    return;
  }
  const runtime = new Runtime(service, values.data!, { maintenance: true });
  try {
    if (command === "inspect") {
      const [type, ...key] = (positionals[1] ?? "").split("/");
      console.log(JSON.stringify(runtime.inspect(type!, key.join("/")), null, 2));
    } else if (command === "migrate") { runtime.migrate(); console.log("Migration complete"); }
    else if (command === "backup") {
      if (!values.to) throw new Error("backup requires --to <directory>");
      console.log(await runtime.backup(values.to));
    } else if (command === "messages") {
      const action = positionals[1];
      if (action === "list") console.log(JSON.stringify(runtime.messages(values.status), null, 2));
      else if (action === "retry" && positionals[2]) { runtime.retry(positionals[2]); console.log("Message pending"); }
      else if (action === "archive" && positionals[2]) { runtime.archive(positionals[2], values.reason ?? ""); console.log("Message archived"); }
      else throw new Error("Use messages list, retry <id>, or archive <id> --reason <text>");
    } else throw new Error(`Unknown command: ${command}`);
  } finally { runtime.close(); }
}

function entryFile(value: string) {
  const path = resolve(value);
  const entry = statSync(path).isDirectory() ? join(path, "index.ts") : path;
  if (!existsSync(entry)) throw new Error(`Entry point not found: ${entry}`);
  return entry;
}
export async function build(entry: string, outfile: string) {
  const path = entryFile(entry);
  let directory = dirname(path), config: string | undefined;
  for (;;) {
    if (existsSync(join(directory, "tsconfig.json"))) { config = join(directory, "tsconfig.json"); break; }
    const parent = dirname(directory); if (parent === directory) break; directory = parent;
  }
  const temporary = mkdtempSync(join(dirname(path), ".carina-build-"));
  try {
    const checkedConfig = join(temporary, "tsconfig.json");
    writeFileSync(checkedConfig, JSON.stringify({
      ...(config ? { extends: config } : {}),
      compilerOptions: { target: "ESNext", module: "ESNext", moduleResolution: "Bundler", strict: true, skipLibCheck: true, allowImportingTsExtensions: true, noEmit: true },
      files: [path], include: [], exclude: [],
    }));
    const compiler = fileURLToPath(import.meta.resolve("typescript/bin/tsc"));
    const checked = Bun.spawn([process.execPath, compiler, "--noEmit", "--project", checkedConfig], { stdout: "inherit", stderr: "inherit" });
    if (await checked.exited) throw new Error("Service type-check failed");
    const application = (await import(pathToFileURL(path).href)).default;
    if (!application?.actors || !application?.name || !application?.version) throw new Error("Entry point must default-export a service");
    const generated = join(temporary, "main.ts");
    writeFileSync(generated, `import service from ${JSON.stringify(path)};\nimport {runApplication} from ${JSON.stringify(fileURLToPath(import.meta.url))};\nrunApplication(service).catch(error=>{console.error(error);process.exitCode=1});\n`);
    mkdirSync(dirname(resolve(outfile)), { recursive: true });
    const result = await Bun.build({ entrypoints: [generated], compile: { outfile: resolve(outfile) }, minify: true });
    if (!result.success) throw new AggregateError(result.logs, "Build failed");
    console.log(`Built ${resolve(outfile)}`);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

async function main() {
  const args = Bun.argv.slice(2), { values, positionals } = argumentsFor(args);
  if (positionals[0] === "build" && positionals[1]) { await build(positionals[1], values.out ?? "./dist/app"); return; }
  if (positionals[0] === "dev" && positionals[1]) {
    const entry = entryFile(positionals[1]);
    const key = process.env.CARINA_ACCESS_KEY ?? "dev";
    if (key === "dev") console.log("Local development access key: dev");
    const process_ = Bun.spawn([process.execPath, "--watch", fileURLToPath(new URL("./runner.ts", import.meta.url)), entry, "serve", "--data", values.data!, "--host", values.host!, "--port", values.port!], { stdout: "inherit", stderr: "inherit", env: { ...process.env, CARINA_ACCESS_KEY: key } });
    const stop = () => process_.kill(); process.once("SIGINT", stop); process.once("SIGTERM", stop);
    process.exitCode = await process_.exited; return;
  }
  console.log("carina build <file-or-directory> --out <executable>\ncarina dev <file-or-directory> --data <directory>");
}
if (import.meta.main) main().catch(error => { console.error(error); process.exitCode = 1; });
