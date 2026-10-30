# Testing and performance

Run checks from the repository root:

```sh
bun run typecheck
bun test
bun run build:example
bun run benchmark
```

Tests cover 1,000 concurrent reservations, state and send rollback, idempotency, message retries and archival, upgrades, migration rollback, backups, authentication, watches and reconnection, directory locking, and a compiled service killed with `SIGKILL` during delivery. Integration tests bind temporary localhost ports. The executable and crash-recovery tests are exercised on Linux x64.

[Type checks](../tests/types.ts) cover invalid state assignments, inputs, sends, replies, and client access to internal actions.

## Benchmark workloads

The benchmark records local mutation throughput and latency, startup time, and watch refresh time with 1, 10, and 100 subscriptions in [benchmarks/local.json](../benchmarks/local.json). These are measurements of the execution host and its temporary filesystem. The top-level throughput and latency describe sequential direct runtime calls, each with its own durable commit. The `concurrent` result measures acknowledged HTTP actions with up to 64 clients, which exercises group commit. Both workloads verify final stock, and both use WAL with `synchronous=FULL`.

A caller awaiting each action before sending the next pays individual commit latency. Concurrent callers let ready actions share that latency. The matched original/current results in [group-commit-comparison.json](../benchmarks/group-commit-comparison.json) report both workloads separately.

## Performance regression test

`bun run benchmark:test` runs the benchmark as a regression test. It is also included in `bun test` and saves its measurements and budgets in [benchmarks/test-latest.json](../benchmarks/test-latest.json). Defaults use 500 durable mutations with these configurable budgets:

| Environment variable | Default | Check |
| --- | --- | --- |
| `CARINA_BENCH_MIN_OPS` | 100 | Minimum committed actions per second |
| `CARINA_BENCH_MIN_CONCURRENT_OPS` | 500 | Minimum committed HTTP actions per second with concurrent clients |
| `CARINA_BENCH_MAX_P99_MS` | 100 | Maximum p99 mutation latency in either workload, in milliseconds |
| `CARINA_BENCH_MAX_STARTUP_MS` | 2000 | Maximum startup time in milliseconds |
| `CARINA_BENCH_MAX_WATCH_MS` | 1000 | Maximum refresh time at each subscription count in milliseconds |
| `CARINA_BENCH_MUTATIONS` | 500 | Number of measured actions in each workload |

These defaults are broad regression guards. Set the budgets for the hardware and filesystem used by CI, for example `CARINA_BENCH_MIN_OPS=250 bun run benchmark:test`. Every run also checks that the measured mutations and watch results are correct.

[Documentation](README.md)
