# Quickstart

**TL;DR:** Run a complete shop locally: create a Hiking Boot, reserve two units through actor messages, and watch the order complete. You need Bun 1.4.4 or newer. The development server uses `127.0.0.1:7070` and access key `dev` by default; data persists in `./data`.

The product begins with 10 units in stock. An order asks for two, the product decides whether it can reserve them, and the order records the answer. Following that small purchase shows how actor state, durable communication, and realtime reads fit together in one service.

Development and builds require Bun 1.4.4 or newer. From the repository root:

```sh
bun install
bun src/cli.ts dev examples/shop --data ./data
```

In another terminal:

```sh
bun examples/checkout.ts
```

Local development uses access key `dev` when `CARINA_ACCESS_KEY` is unset. The example creates a Hiking Boot with stock 10, creates an order for two units, starts its reservation, watches the result, and prints stock 8. Its stable request IDs make rerunning the example safe.

The [shop service](../examples/shop/index.ts) registers two actor types, `product` and `order`, and the named queries `catalog` and `orderStatus`. The order sends a durable reservation message to the product, which sends a result back. Each actor persists its own turn; the client watches the order until it completes.

The development server listens at `http://127.0.0.1:7070`, stores data in `./data`, and restarts when source files change. If you set `CARINA_ACCESS_KEY`, give both terminals the same value.

## Build an executable

Stop the development server before running the executable against the same data directory:

```sh
bun src/cli.ts build examples/shop --out ./dist/shop
CARINA_ACCESS_KEY='replace-with-your-key' ./dist/shop serve --data ./data
```

The build embeds the service and Bun runtime into an executable for the build host.

The compiled service can reopen the same data directory and continue from the orders and stock you created in development. The actor definitions, validation rules, and message handlers you just exercised are the same ones the compiled service runs.

Continue with [state and actions](actors.md), the [TypeScript client](client.md), or [building and operating a service](cli.md).

[Documentation](README.md)
