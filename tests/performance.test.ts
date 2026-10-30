import { expect, test } from "bun:test";
import { benchmark } from "../scripts/benchmark";

function setting(name: string, fallback: number) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
}

test("performance budgets: durable throughput, p99 latency, startup and watch refresh", async () => {
  const budgets = {
    minActionsPerSecond: setting("CARINA_BENCH_MIN_OPS", 100),
    minConcurrentActionsPerSecond: setting("CARINA_BENCH_MIN_CONCURRENT_OPS", 500),
    maxP99Ms: setting("CARINA_BENCH_MAX_P99_MS", 100),
    maxStartupMs: setting("CARINA_BENCH_MAX_STARTUP_MS", 2000),
    maxWatchRefreshMs: setting("CARINA_BENCH_MAX_WATCH_MS", 1000),
  };
  const result = await benchmark({ mutations: setting("CARINA_BENCH_MUTATIONS", 500) });
  await Bun.write("benchmarks/test-latest.json", JSON.stringify({ budgets, result }, null, 2) + "\n");
  expect(result.actionsPerSecond).toBeGreaterThanOrEqual(budgets.minActionsPerSecond);
  expect(result.concurrent.actionsPerSecond).toBeGreaterThanOrEqual(budgets.minConcurrentActionsPerSecond);
  expect(result.latencyMs.p99).toBeLessThanOrEqual(budgets.maxP99Ms);
  expect(result.concurrent.latencyMs.p99).toBeLessThanOrEqual(budgets.maxP99Ms);
  expect(result.startupMs).toBeLessThanOrEqual(budgets.maxStartupMs);
  expect(result.watches.map(sample => sample.subscriptions)).toEqual([1, 10, 100]);
  for (const sample of result.watches) expect(sample.refreshMs).toBeLessThanOrEqual(budgets.maxWatchRefreshMs);
}, 30_000);
