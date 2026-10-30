# Actor-to-actor communication

Use `send` inside an action to buffer a durable message to another actor in the service.

## Send a message

The [shop order's `start` action](../examples/shop/index.ts) changes its status and requests a reservation:

```typescript
start: action({}, ({ state, send }) => {
  if (state.status === "new") {
    state.status = "reserving";
    send.product(state.sku).reserveForOrder({ qty: state.qty });
  }
  return { status: state.status };
}),
```

`send.product(key).reserveForOrder({ qty })` buffers a message. The sender's state, receipt, and outgoing messages commit together. The dispatcher executes receiver turns sequentially. Receiver state, response messages, and the incoming processed marker commit together.

The single `messages` table supplies both outbox and inbox roles. Failed messages remain inspectable and can be retried with the same ID. Archiving pending or failed messages records abandonment; archiving processed messages preserves their completion time. Message completion markers remain stored independently of gateway receipts.

The dispatcher snapshots up to 64 already-committed pending messages and processes their turns with savepoints inside one durable transaction. New response messages become eligible in the next group, after their sender has committed.

A gateway reply acknowledges the sender's commit. Query or watch the order to observe the completed reservation. External effects such as payments need the external system's idempotency support.

## Type the send methods

Register your service type so `send` knows its actors, public actions, internal actions, and input schemas:

```typescript
export type Shop = typeof shop;
declare module "carina" {
  interface Register { service: Shop }
}
```

Mutually recursive sends can require an explicit action input/state type annotation. The example's `reserveForOrder` shows that annotation, along with sender checks on both internal actions.

## Inspect and recover

Stop the server before inspecting or changing messages:

```sh
./dist/shop messages list --status failed --data ./data
./dist/shop messages retry 42 --data ./data
./dist/shop messages archive 42 --reason 'Order cancelled' --data ./data
```

See [durability and concurrency](durability.md) for failure scope, [build and operate](cli.md) for maintenance, and the [MVP specification](../SPEC.md) for transaction and message lifecycle diagrams.

[Documentation](README.md)
