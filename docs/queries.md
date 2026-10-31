# Queries and realtime

**TL;DR:** Build catalogs and other views across actors with read-only SQL, then watch those views for changes. Queries see the current logical state after actor upgrades. Watches send an initial result and changed results, coalescing refreshes to at most once per 50 milliseconds; they deliver current state rather than every intermediate change.

Register named queries in the service's `queries` map. Queries run synchronously as trusted application code and receive a read-only connection:

```typescript
import { Schema } from "effect";
import { query } from "carina";

const Stock = Schema.Int.pipe(Schema.nonNegative());
const catalog = query({ minStock: Stock }, ({ db }, { minStock }) => db.all(
  Schema.Struct({ key: Schema.String, stock: Stock }),
  `SELECT key, json_extract(state, '$.stock') AS stock
   FROM actors WHERE type = 'product' AND json_extract(state, '$.stock') >= ?
   ORDER BY key LIMIT 1000`,
  [minStock],
));
```

The client provides `queries.catalog.query({ minStock: 0 })` and `queries.catalog.watch({ minStock: 0 })`. Watches yield an initial result, then changed results, and reconnect after transport interruptions. They coalesce updates and retain the latest pending result for slow readers. Returning from the iterator closes its subscription. All watches refresh after commits, at most once per 50 milliseconds; query cost determines capacity.

HTTP requests use a Bearer token. WebSockets authenticate with `{ op: "auth", accessKey }` before subscribing. Gateway calls can invoke public actions. Internal actions accept actor messages with authenticated sender type, key, and message ID.

## Query and watch

Use a query when you need a snapshot, such as loading the catalog. Use a watch when the screen should follow changes, such as an order waiting for its reservation result. Both use the same query definition, so the initial read and subsequent updates follow the same filtering and validation rules.

Using the [typed shop client](client.md):

```typescript
const rows = await shop.queries.catalog.query({ minStock: 0 });

for await (const rows of shop.queries.catalog.watch({ minStock: 0 })) {
  console.log(rows);
}
```

The client uses one WebSocket per watch.

After the example order reserves two Hiking Boots, a catalog watch can show stock changing from 10 to 8. It delivers current results as they change; coalescing allows a busy screen to catch up to the latest state without displaying every intermediate result.

## Logical state

The `actors` view exposes `type`, `key`, and the current JSON state. It applies each actor's upgrade chain before SQL filtering, sorting, and aggregation. A query written for ProductV2 sees ProductV2-shaped state even while some stored rows still have ProductV1 data.

Reading leaves stored rows unchanged. See [upgrades and migrations](migrations.md) for the SQLite implementation and persistence rules.

[Documentation](README.md)
