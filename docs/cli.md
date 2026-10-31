# Build and operate

**TL;DR:** Package multiple actor types and queries into one standalone service executable for the build host. Bun 1.4.4 or newer is needed for development and builds; the executable embeds its runtime. Preserve the data directory between releases, set `CARINA_ACCESS_KEY` explicitly, and stop the service before inspection, message maintenance, migrations, or backups.

For the shop, the product and order actors belong to one deployable service. Building packages their code and runtime together; the data directory holds the durable state between runs. That gives deployment two concrete pieces to manage: the executable you release and the data you preserve.

## Develop

From the repository root, with Bun 1.4.4 or newer:

```sh
bun install
bun src/cli.ts dev examples/shop --data ./data
```

Development restarts the service when source files change. The local access key defaults to `dev` when `CARINA_ACCESS_KEY` is unset.

## Build and serve

```sh
bun src/cli.ts build examples/shop --out ./dist/shop
CARINA_ACCESS_KEY='replace-with-your-key' ./dist/shop serve --data ./data
```

A directory resolves to its `index.ts`; a file can also be passed directly. The entry point default-exports a service. Build type-checks the entry point and its imports using the nearest project configuration and compiles the service, SDK, and Bun runtime into one executable for the build host. The generated executable runs independently of this source directory and its `node_modules`.

The server binds to `127.0.0.1:7070`. Set `--host` and `--port` as needed, and put network deployments behind an HTTPS reverse proxy. The implementation uses Bun's HTTP, WebSocket, and SQLite APIs, plus Effect Schema for validation.

## Maintenance

When investigating a stuck reservation, inspect the order and its messages to find where work stopped. Before a release that changes stored data, take a backup and run the migration command. These operations use the same service definitions as normal execution, keeping the operational tools aligned with the application.

Stop the server before maintenance commands:

```sh
./dist/shop inspect product/sku-1 --data ./data
./dist/shop messages list --status failed --data ./data
./dist/shop messages retry 42 --data ./data
./dist/shop messages archive 42 --reason 'Order cancelled' --data ./data
./dist/shop migrate --data ./data
./dist/shop backup --data ./data --to ./backup
```

Each command holds an exclusive SQLite lock on `.lock` in the data directory. The operating system releases it after process termination, including `SIGKILL`.

## Configuration

| Option | Default | Purpose |
| --- | --- | --- |
| `--data` | `./data` | Service data directory |
| `--host` | `127.0.0.1` | Bind address for `dev` or `serve` |
| `--port` | `7070` | Listen port for `dev` or `serve` |
| `--out` | `./dist/app` | Output executable for `build` |
| `CARINA_ACCESS_KEY` | `dev` in development | Access key supplied to clients; set it explicitly for the executable |

See [upgrades and migrations](migrations.md) for deployment upgrades, [messaging](messaging.md) for retries and archival, and [testing and performance](testing.md) for verification.

[Documentation](README.md)
