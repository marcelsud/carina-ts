# TypeScript client

The client derives actor methods, input types, replies, and queries from your service type. These snippets use the repository's [shop service](../examples/shop/index.ts); paths are relative to a client file in `examples/`.

## Connect

```typescript
import { client } from "carina/client";
import type { Shop } from "./shop";

const shop = client<Shop>({
  url: "http://127.0.0.1:7070",
  accessKey: process.env.CARINA_ACCESS_KEY ?? "dev",
});
```

The service import supplies TypeScript types. The client handles HTTP Bearer authentication and WebSocket authentication for watches.

## Create and call actors

```typescript
await shop.product.create(
  "sku-1",
  { name: "Hiking Boot", stock: 10 },
  { idempotencyKey: "create-product" },
);

const reply = await shop.product("sku-1").restock(
  { qty: 2 },
  { idempotencyKey: "restock-delivery-1" },
);
console.log(reply.stock);
```

Creation accepts the actor's initial state. Instance methods expose public actions. The runtime reserves internal actions for [actor messages](messaging.md).

## Retry requests

The client generates an idempotency key when one is omitted and retains it across its network retries. The `retries` client option defaults to 2. Use an explicit stable key when the same logical operation can be retried through a new client call or after an application restart.

HTTP failures reject with tagged error objects. A full mutation queue returns `Overloaded` with HTTP `503`; handle it in the application and retry later with the same key. See [durability and concurrency](durability.md) for admission and commit behavior.

## Read and subscribe

```typescript
console.log(await shop.queries.catalog.query({ minStock: 0 }));

for await (const rows of shop.queries.orderStatus.watch({ key: "o-1" })) {
  console.log(rows);
  if (rows[0]?.status === "reserved" || rows[0]?.status === "rejected") break;
}
```

This watch expects an existing order such as the one created by the [checkout example](../examples/checkout.ts). Breaking the loop closes the subscription. See [queries and realtime](queries.md) for refresh, coalescing, and reconnection behavior.

[Documentation](README.md)
