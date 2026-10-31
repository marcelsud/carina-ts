# Upgrades and migrations

**TL;DR:** Evolve your data model while keeping existing actors usable. Pure, synchronous upgrade steps give actions and queries the current state shape before every row has been rewritten; successful actions persist upgraded state. Keep published steps stable and append new ones. Stop the service and run `migrate` to convert all rows or apply explicit storage changes atomically.

Carina applies that description when it reads an older actor. Actions and queries can use the current schema while stored rows move forward incrementally. This keeps the compatibility rule in one place, rather than repeating missing-field checks throughout the application.

## Use a transformation function to add or update fields

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

This step assigns existing products to `general`. Choosing that default is a business decision: the upgrade makes it explicit and applies it consistently to old rows. Future schema changes add further steps, so a product untouched since the first release can still travel through the complete chain.

Keep published steps stable and append new ones. Older rows depend on that history to reach the current state.

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

This lets a catalog query use `category` consistently across products created before and after the change. The application can adopt the new field without first rewriting every existing product.

Rows store a version equal to the number of applied steps. Reuse the same schema object between adjacent upgrade boundaries and for the actor's current state. Reads use a connection-local `TEMP VIEW actors` backed by a `carina_state` SQL function. It evaluates upgrades before SQL filtering, sorting, and aggregation, leaving stored rows unchanged.

The next successful action persists the current state and version. A frequently updated product therefore moves to the new stored shape naturally. A product that is only read continues to run its upgrade during reads; running `migrate` applies upgrades to all rows in one transaction and completes that stored conversion at a chosen maintenance time.

## Migrate storage

Storage structure changes use the service's integer `version` and `migrations: [{ from, to, run(db) }]`. Each step advances one storage version. The migration command runs the chain, validates all actor states and pending message contracts, and commits atomically. Pending message payloads can be transformed in these migrations. Startup rejects newer stored actor versions, mismatched storage versions, and incompatible pending inputs.

For example, a later reservation action might require a new field in its message input. Existing pending messages need that field too. A storage migration can transform those payloads before the new service starts delivering them. If migration or validation fails, the transaction rolls back its changes, giving you a clear point to diagnose and retry the upgrade.

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
