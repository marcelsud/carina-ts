# Upgrades and migrations

**TL;DR:** Evolve your data model while keeping existing actors usable. Pure, synchronous upgrade steps give actions and queries the current state shape before every row has been rewritten; successful actions persist upgraded state. Keep published steps stable and append new ones. Stop the service and run `migrate` to convert all rows or apply explicit storage changes atomically.

The shop starts with a flat product record. As it grows, the catalog needs categories, inventory needs to distinguish available stock from reservations, and wholesale orders need quantity pricing. Each release can express its change as a small transformation that builds on the previous schema.

Carina runs the missing steps in order whenever it reads an older actor. Actions and queries receive the current shape, keeping compatibility rules in one place.

## Use a transformation function to add or update fields

This example takes a product through four schemas and three upgrade steps. The original `stock` counts all units on hand, including `reserved` units. Prices are stored in integer cents, and the shop's existing prices are in USD.

### Define the original state

```typescript
import { Schema } from "effect";
import { actor, upgrade } from "carina";

const Count = Schema.Int.pipe(Schema.nonNegative());
const ProductV1 = Schema.Struct({
  name: Schema.String,
  stock: Count,
  reserved: Count,
  unitPriceCents: Count,
});
```

### Add a field with a default

The first change introduces categories. Existing products start in `general`; later actions can assign a more specific category.

```typescript
const ProductV2 = Schema.Struct({
  ...ProductV1.fields,
  category: Schema.String,
});

const addCategory = upgrade(ProductV1, ProductV2, (state) => ({
  ...state,
  category: "general",
}));
```

### Restructure state and check an invariant

The next change groups inventory and pricing into nested objects. Available stock is calculated by subtracting reservations from total stock. The transformation rejects inconsistent records instead of converting them into a negative available quantity.

```typescript
const ProductV3 = Schema.Struct({
  name: Schema.String,
  category: Schema.String,
  inventory: Schema.Struct({
    available: Count,
    reserved: Count,
  }),
  pricing: Schema.Struct({
    unitPriceCents: Count,
  }),
});

const nestInventory = upgrade(ProductV2, ProductV3, (state) => {
  if (state.reserved > state.stock) {
    throw new Error("Reserved stock exceeds total stock");
  }

  return {
    name: state.name,
    category: state.category,
    inventory: {
      available: state.stock - state.reserved,
      reserved: state.reserved,
    },
    pricing: {
      unitPriceCents: state.unitPriceCents,
    },
  };
});
```

Ten Hiking Boots with two reserved become eight available and two reserved. The old flat fields are replaced by the nested structure. If a record has more reservations than total stock, its upgrade fails with the actor identity and failed step so you can investigate the data.

### Update fields based on other fields

The third change introduces quantity pricing. The shop keeps the original unit price for regular purchases and gives orders of at least ten units a 10% discount. The discounted price is rounded to the nearest cent once during this transformation.

```typescript
const PriceTier = Schema.Struct({
  minQuantity: Schema.Int.pipe(Schema.positive()),
  unitPriceCents: Count,
});

const ProductV4 = Schema.Struct({
  ...ProductV3.fields,
  pricing: Schema.Struct({
    currency: Schema.Literal("USD"),
    tiers: Schema.Array(PriceTier),
  }),
});

const addQuantityPricing = upgrade(ProductV3, ProductV4, (state) => ({
  ...state,
  pricing: {
    currency: "USD" as const,
    tiers: [
      { minQuantity: 1, unitPriceCents: state.pricing.unitPriceCents },
      {
        minQuantity: 10,
        unitPriceCents: Math.round((state.pricing.unitPriceCents * 90) / 100),
      },
    ],
  },
}));
```

A unit price of 12,999 cents produces a wholesale price of 11,699 cents. This conversion records the shop's pricing rule at this point in its history. After the upgrade, actions that change prices should update the stored tiers according to the current business rules.

### Register the ordered chain

```typescript
const product = actor(ProductV4)({
  upgrades: [addCategory, nestInventory, addQuantityPricing],
});
```

Each step's destination schema is the next step's source schema, and the final destination is the actor's current state schema. Reuse those schema objects as shown. Carina decodes the input and validates the output at each boundary.

| Stored shape | Stored version | Steps applied to reach ProductV4             |
| ------------ | -------------- | -------------------------------------------- |
| ProductV1    | 0              | Category, nested inventory, quantity pricing |
| ProductV2    | 1              | Nested inventory, quantity pricing           |
| ProductV3    | 2              | Quantity pricing                             |
| ProductV4    | 3              | Already current                              |

A product untouched since the first release follows the whole chain. A product already stored as ProductV3 only needs the last step. Schema names such as `ProductV4` are application names; the stored version counts applied steps, starting at zero. Actor upgrade steps are separate from the service's storage `version` used for explicit storage migrations.

Keep published steps stable and append new ones. Older rows depend on that history to reach the current state. Functions must be pure and synchronous: use their input and fixed rules, keeping network calls, current-time lookups, and other external effects outside the transformation.

## Query across versions

A ProductV1 row for Hiking Boot might contain:

```json
{
  "name": "Hiking Boot",
  "stock": 10,
  "reserved": 2,
  "unitPriceCents": 12999
}
```

Queries through `actors` see the logical ProductV4 state after all three steps:

```json
{
  "name": "Hiking Boot",
  "category": "general",
  "inventory": { "available": 8, "reserved": 2 },
  "pricing": {
    "currency": "USD",
    "tiers": [
      { "minQuantity": 1, "unitPriceCents": 12999 },
      { "minQuantity": 10, "unitPriceCents": 11699 }
    ]
  }
}
```

A filter on `category = 'general'` includes this row while it is still stored as ProductV1. SQL expressions such as `json_extract(state, '$.inventory.available')` also see the calculated, nested value. The transformations run before SQL filtering, sorting, and aggregation, so a catalog can query one current shape across products from different releases.

The read connection implements this through a connection-local `TEMP VIEW actors` backed by the `carina_state` SQL function. Reading leaves stored rows unchanged. The next successful action persists the upgraded state and version with its own changes; an action that fails leaves the stored row at its previous version.

A product that is only read continues to run its missing upgrades during reads. Running `migrate` applies upgrades to all rows in one transaction, completing the stored conversion at a chosen maintenance time. If any row fails, such as one with inconsistent reservations, that migration transaction rolls back its changes.

## Migrate storage

Storage structure changes use the service's integer `version` and `migrations: [{ from, to, run(db) }]`. Each step advances one storage version. The migration command runs the chain, validates all actor states and pending message contracts, and commits atomically. Pending message payloads can be transformed in these migrations. Startup rejects newer stored actor versions, mismatched storage versions, and incompatible pending inputs.

For example, a later reservation action might require a new field in its message input. Existing pending messages need that field too. A storage migration can transform those payloads before the new service starts delivering them. If migration or validation fails, the transaction rolls back its changes, giving you a clear point to diagnose and retry the upgrade.

## Upgrade a deployment

Create a backup before replacing an executable. The backup command uses SQLite's backup API. Restore by pointing a compatible executable at the backup directory.

Stop the service, create a backup with the current executable, then run migrations using the new executable:

```sh
./dist/shop backup --data ./data --to ./backup
./dist/shop-v4 migrate --data ./data
CARINA_ACCESS_KEY='replace-with-your-key' ./dist/shop-v4 serve --data ./data
```

See [build and operate](cli.md) for maintenance commands and directory locking.

[Documentation](README.md)
