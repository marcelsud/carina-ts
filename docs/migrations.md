# Upgrades and migrations

Append pure, synchronous steps to an actor's `upgrades` array:

```typescript
import { Schema } from "effect";
import { actor, upgrade } from "carina";

const ProductV1 = Schema.Struct({ name: Schema.String, stock: Schema.Int });
const ProductV2 = Schema.Struct({ ...ProductV1.fields, category: Schema.String });
const product = actor(ProductV2)({
  upgrades: [upgrade(ProductV1, ProductV2, state => ({ ...state, category: "general" }))],
});
```

## Query across versions

A ProductV1 row for Hiking Boot might contain:

```json
{ "name": "Hiking Boot", "stock": 10 }
```

Queries through `actors` see the logical ProductV2 state:

```json
{ "name": "Hiking Boot", "stock": 10, "category": "general" }
```

A filter on `category = 'general'` includes this row while it is still stored as ProductV1. The upgrade runs before the SQL filter.

Rows store a version equal to the number of applied steps. Reuse the same schema object between adjacent upgrade boundaries and for the actor's current state. Reads use a connection-local `TEMP VIEW actors` backed by a `carina_state` SQL function. It evaluates upgrades before SQL filtering, sorting, and aggregation, leaving stored rows unchanged. The next successful action persists the current state and version. `migrate` applies upgrades to all rows in one transaction.

## Migrate storage

Storage structure changes use the service's integer `version` and `migrations: [{ from, to, run(db) }]`. Each step advances one storage version. The migration command runs the chain, validates all actor states and pending message contracts, and commits atomically. Pending message payloads can be transformed in these migrations. Startup rejects newer stored actor versions, mismatched storage versions, and incompatible pending inputs.

## Upgrade a deployment

Create a backup before replacing an executable. The backup command uses SQLite's backup API. Restore by pointing a compatible executable at the backup directory.

Stop the service, create a backup with the current executable, then run migrations using the new executable:

```sh
./dist/shop backup --data ./data --to ./backup
./dist/shop-v2 migrate --data ./data
CARINA_ACCESS_KEY='replace-with-your-key' ./dist/shop-v2 serve --data ./data
```

See [build and operate](cli.md) for maintenance commands and directory locking.

[Documentation](README.md)
