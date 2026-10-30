# State and actions

An actor owns state validated by an Effect Schema. Its type and key identify an instance: `product` and `sku-1`, for example. Actions receive mutable state and validated input, then return a JSON reply.

## Define an actor

```typescript
import { Schema } from "effect";
import { actor, action } from "carina";

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

The two-stage `actor(State)({ ... })` form lets TypeScript infer mutable state inside nested action callbacks. The single-object `actor({ state: State, ... })` form is accepted too; use the two-stage form when you want inferred state checking.

Actions and queries run synchronously as trusted application code. Actions return JSON values. The runtime decodes inputs and stored state, validates resulting state, and rejects invalid replies before commit. Declared Effect tagged errors become HTTP 422 responses. The client rejects failed requests with tagged error objects.

[The shop example](../examples/shop/index.ts) contains a full service with public actions, internal actions, typed actor sends, and named queries. Mutually recursive sends can need an explicit action input/state type annotation, as shown by `reserveForOrder`.

## Register a service

Add actor types and named queries to a service, then default-export it from your entry point for the CLI:

```typescript
import { service } from "carina";

export const shop = service({ name: "shop", version: 1, actors: { product } });
export type Shop = typeof shop;
export default shop;
```

A service can register multiple actor types. The [shop entry point](../examples/shop/index.ts) includes both `product` and `order`.

## Action context

| Field | Meaning |
| --- | --- |
| `state` | Mutable state for this turn |
| `key` | This actor's key |
| `now` | Timestamp supplied for this turn |
| `caller` | Client identity or the sending actor's type and key |
| `messageId` | Incoming durable message ID, when present |
| `send` | Typed methods for buffering outgoing actor messages |

Gateway calls invoke methods declared in `actions`. Methods in `internal` accept actor messages with sender identity supplied by the runtime. Check `caller` when a method requires a particular sender.

Continue with [actor-to-actor communication](messaging.md), the [TypeScript client](client.md), or [durability and concurrency](durability.md).

[Documentation](README.md)
