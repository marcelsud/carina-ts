# Carina

Typed actors, durable actor messages, and reactive queries in one executable and one SQLite database.

Define actors in TypeScript, connect through a typed client, and build a standalone service executable. Development and builds require Bun 1.4.4 or newer.

**[Documentation](docs/README.md)** · **[Quickstart](docs/quickstart.md)** · **[Shop example](examples/shop/index.ts)**

```sh
bun install
bun src/cli.ts dev examples/shop --data ./data
```

In another terminal, run `bun examples/checkout.ts` to create a Hiking Boot, reserve two units through actor messages, and watch the order complete.

See [building and operating a service](docs/cli.md) for executable builds and [testing and performance](docs/testing.md) for checks and benchmarks.
