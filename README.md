# Carina

Typed actors, durable actor messages, and reactive queries in one executable and one SQLite database.

Development and builds require Bun 1.4.4 or newer. Generated executables include the runtime. The implementation uses Bun's HTTP, WebSocket, and SQLite APIs, plus Effect Schema for validation.

## Run the example

From this directory:

```sh
bun install
bun src/cli.ts dev examples/shop --data ./data
```

In another terminal:

```sh
bun examples/checkout.ts
```

Local development uses access key `dev` when `CARINA_ACCESS_KEY` is unset. The example creates a Hiking Boot with stock 10, creates an order for two units, starts its reservation, watches the result, and prints stock 8. Its stable request IDs make rerunning the example safe.

## Build an executable

```sh
bun src/cli.ts build examples/shop --out ./dist/shop
CARINA_ACCESS_KEY='replace-with-your-key' ./dist/shop serve --data ./data
```

A directory resolves to its `index.ts`; a file can also be passed directly. The entry point default-exports a service. Build type-checks its project and compiles the service, SDK, and Bun runtime into one executable for the build host. The generated executable runs independently of this source directory and its `node_modules`.

The server binds to `127.0.0.1:7070`. Set `--host` and `--port` as needed, and put network deployments behind an HTTPS reverse proxy. Stop the server before maintenance commands:

```sh
./dist/shop inspect product/sku-1 --data ./data
./dist/shop messages list --status failed --data ./data
./dist/shop messages retry 42 --data ./data
./dist/shop messages archive 42 --reason 'Order cancelled' --data ./data
./dist/shop migrate --data ./data
./dist/shop backup --data ./data --to ./backup
```

Each command holds an exclusive SQLite lock on `.lock` in the data directory. The operating system releases it after process termination, including `SIGKILL`.

## Define actors

```typescript
import { Schema } from "effect";
import { actor, action, query, service } from "carina";

const State = Schema.Struct({ stock: Schema.Int.pipe(Schema.nonNegative()) });
const product = actor(State)({
  actions: {
    restock: action({ qty: Schema.Int.pipe(Schema.positive()) }, ({ state }, { qty }) => {
      state.stock += qty;
      return { stock: state.stock };
    }),
  },
});
```

The two-stage `actor(State)({ ... })` form lets TypeScript infer mutable state inside nested action callbacks. The specification's single-object `actor({ state: State, ... })` form is accepted too; use the two-stage form when you want inferred state checking. `tests/types.ts` checks invalid state assignments, inputs, sends, replies, and client access to internal actions.

Actions and queries run synchronously as trusted application code. Actions return JSON values. The runtime decodes inputs and stored state, validates resulting state, and rejects invalid replies before commit. Declared Effect tagged errors become HTTP 422 responses. The client rejects failed requests with tagged error objects.

`examples/shop/index.ts` contains a full service with public actions, internal actions, typed actor sends, and named queries. Mutually recursive sends can need an explicit action input/state type annotation, as shown by `reserveForOrder`.

Ready gateway calls share a durable SQLite commit in groups of up to 64. The queue flushes on the next event loop turn. Each action runs inside a native SQLite savepoint, so its failure rolls back its own state and sends. Replies and watch notifications are released after the outer commit succeeds; a failed outer commit rejects the whole group. WAL and `synchronous=FULL` remain enabled.

One global queue admits up to 1,024 waiting gateway mutations, including creation and action calls. A full queue returns HTTP `503` with error tag `Overloaded` before executing the new call. Rejection changes no state, records no new receipt, and sends no messages. Retry later with the same idempotency key; the client surfaces the error for application-controlled retries. Draining a batch frees capacity. The active batch is separate from the waiting limit, and reads, watches, and durable message dispatch use their existing paths.

## Durable messaging

`send.product(key).reserveForOrder({ qty })` buffers a message. The sender's state, receipt, and outgoing messages commit together. The dispatcher executes one pending message at a time. Receiver state, response messages, and the incoming processed marker commit together.

The single `messages` table supplies both outbox and inbox roles. Failed messages remain inspectable and can be retried with the same ID. Archiving pending or failed messages records abandonment; archiving processed messages preserves their completion time. Message completion markers remain stored independently of gateway receipts.

The dispatcher snapshots up to 64 already-committed pending messages and processes their turns with savepoints inside one durable transaction. New response messages become eligible in the next group, after their sender has committed.

A gateway reply acknowledges the sender's commit. Query or watch the order to observe the completed reservation. External effects such as payments need the external system's idempotency support.

## Queries and watches

Named queries receive a read-only connection:

```typescript
const catalog = query({}, ({ db }) => db.all(
  Schema.Struct({ key: Schema.String, stock: Schema.Int }),
  `SELECT key, json_extract(state, '$.stock') AS stock
   FROM actors WHERE type = 'product' ORDER BY key`,
));
```

The client provides `queries.catalog.query({})` and `queries.catalog.watch({})`. Watches yield an initial result, then changed results, and reconnect after transport interruptions. They coalesce updates and retain the latest pending result for slow readers. Returning from the iterator closes its subscription. All watches refresh after commits, at most once per 50 milliseconds; query cost determines capacity.

HTTP requests use a Bearer token. WebSockets authenticate with `{ op: "auth", accessKey }` before subscribing. Gateway calls can invoke public actions. Internal actions accept actor messages with authenticated sender type, key, and message ID.

## State upgrades and migrations

Append pure, synchronous steps to an actor's `upgrades` array:

```typescript
import { upgrade } from "carina";

const ProductV1 = Schema.Struct({ name: Schema.String, stock: Schema.Int });
const ProductV2 = Schema.Struct({ ...ProductV1.fields, category: Schema.String });
const product = actor(ProductV2)({
  upgrades: [upgrade(ProductV1, ProductV2, state => ({ ...state, category: "general" }))],
});
```

Rows store a version equal to the number of applied steps. Reuse the same schema object between adjacent upgrade boundaries and for the actor's current state. Reads use a connection-local `TEMP VIEW actors` backed by a `carina_state` SQL function. It evaluates upgrades before SQL filtering, sorting, and aggregation, leaving stored rows unchanged. The next successful action persists the current state and version. `migrate` applies upgrades to all rows in one transaction.

Storage structure changes use the service's integer `version` and `migrations: [{ from, to, run(db) }]`. Each step advances one storage version. The migration command runs the chain, validates all actor states and pending message contracts, and commits atomically. Pending message payloads can be transformed in these migrations. Startup rejects newer stored actor versions, mismatched storage versions, and incompatible pending inputs.

Create a backup before replacing an executable. The backup command uses SQLite's backup API. Restore by pointing a compatible executable at the backup directory.

## Verification

```sh
bun run typecheck
bun test
bun run build:example
bun run benchmark
```

Tests cover 1,000 concurrent reservations, state and send rollback, idempotency, message retries and archival, upgrades, migration rollback, backups, authentication, watches and reconnection, directory locking, and a compiled service killed with `SIGKILL` during delivery. Integration tests bind temporary localhost ports. The executable and crash-recovery tests are exercised on Linux x64.

The benchmark records local mutation throughput and latency, startup time, and watch refresh time with 1, 10, and 100 subscriptions in `benchmarks/local.json`. These are measurements of the execution host and its temporary filesystem. The top-level throughput and latency describe sequential direct runtime calls, each with its own durable commit. The `concurrent` result measures acknowledged HTTP actions with up to 64 clients, which exercises group commit. Both workloads verify final stock, and both use WAL with `synchronous=FULL`.

A caller awaiting each action before sending the next pays individual commit latency. Concurrent callers let ready actions share that latency. The matched original/current results in `benchmarks/group-commit-comparison.json` report both workloads separately.

`bun run benchmark:test` runs the benchmark as a regression test. It is also included in `bun test` and saves its measurements and budgets in `benchmarks/test-latest.json`. Defaults use 500 durable mutations with these configurable budgets:

| Environment variable | Default | Check |
| --- | --- | --- |
| `CARINA_BENCH_MIN_OPS` | 100 | Minimum committed actions per second |
| `CARINA_BENCH_MIN_CONCURRENT_OPS` | 500 | Minimum committed HTTP actions per second with concurrent clients |
| `CARINA_BENCH_MAX_P99_MS` | 100 | Maximum p99 mutation latency in either workload, in milliseconds |
| `CARINA_BENCH_MAX_STARTUP_MS` | 2000 | Maximum startup time in milliseconds |
| `CARINA_BENCH_MAX_WATCH_MS` | 1000 | Maximum refresh time at each subscription count in milliseconds |
| `CARINA_BENCH_MUTATIONS` | 500 | Number of measured actions in each workload |

These defaults are broad regression guards. Set the budgets for the hardware and filesystem used by CI, for example `CARINA_BENCH_MIN_OPS=250 bun run benchmark:test`. Every run also checks that the measured mutations and watch results are correct.
