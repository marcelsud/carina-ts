# Carina documentation

Carina runs typed actors, durable messages, and reactive SQL queries in one executable backed by one SQLite database. An actor is identified by its type and key, owns validated state, and exposes actions that change that state.

Start with the [quickstart](quickstart.md) to run a shop where an order reserves stock from a product actor and a client watches the result.

## General

- [Quickstart](quickstart.md) — run the example and build your first executable.
- [Complete shop example](../examples/shop/index.ts) — actors, internal messages, and named queries together.

## Features

- [State and actions](actors.md) — define schemas, mutate state, and declare errors.
- [Actor-to-actor communication](messaging.md) — send durable messages and follow their outcomes.
- [Queries and realtime](queries.md) — read logical actor state with SQL and watch changes.

## Concepts

- [Durability and concurrency](durability.md) — commits, savepoints, failure scope, and queue limits.
- [Upgrades and migrations](migrations.md) — evolve state incrementally and migrate stored data.

## Clients

- [TypeScript client](client.md) — create actors, call actions, query, and subscribe.

## Reference

- [Build and operate](cli.md) — development, executable builds, configuration, and maintenance commands.
- [Testing and performance](testing.md) — verification commands, benchmarks, and regression budgets.
- [MVP specification](../SPEC.md) — detailed contracts, storage design, and acceptance criteria.
