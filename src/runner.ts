import { pathToFileURL } from "node:url";
import { runApplication } from "./cli";

try {
  const service = (await import(pathToFileURL(Bun.argv[2]!).href)).default;
  await runApplication(service, Bun.argv.slice(3));
} catch (error) { console.error(error); process.exitCode = 1; }
