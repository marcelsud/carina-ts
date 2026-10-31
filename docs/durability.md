# Durability and concurrency

Carina uses SQLite WAL with `synchronous=FULL`. A successful gateway reply is released after the action's durable commit.

When a client hears that it successfully reserved the last Hiking Boot, that reply should mean the reservation survived the commit. This is also why a lost reply needs an idempotency key: the reservation may already be stored even if the client never received the response.

## Group commits

During a busy checkout period, many orders can be ready at once. Group commits let their actions share the cost of a durable database commit while each action keeps its own rollback boundary. The actions still execute sequentially; batching changes how they pay for persistence.

Ready gateway calls share a durable SQLite commit in groups of up to 64. The queue flushes on the next event loop turn. Each action runs inside a native SQLite savepoint. Replies and watch notifications are released after the outer commit succeeds; a failed outer commit rejects the whole group.

An action that throws rolls back to its savepoint, undoing its state changes and sends. Releasing a savepoint finishes that action's local transaction boundary; the outer commit makes the group's successful actions durable.

Keep the same idempotency key when retrying an uncertain result so a stored receipt can resolve whether the action committed. Concurrent callers can share commit latency; a caller awaiting each action before sending the next pays individual commit latency.

## Failure scope

| Failure | Effect |
| --- | --- |
| An action throws | Its savepoint rolls back; other actions can commit |
| The outer commit fails | The whole group's replies are rejected |
| The process exits during an uncommitted group | SQLite recovery rolls back the incomplete transaction |
| Trusted synchronous actor code hangs | The service process stalls until the code returns or the process is terminated |

Durable messages use savepoints in groups of up to 64 already-committed message IDs. Their response messages are delivered in a later group. See [actor-to-actor communication](messaging.md).

The [MVP specification](../SPEC.md) includes a step-by-step SQL example showing one action rolling back while surrounding actions commit.

## Bounded admission

If requests arrive faster than the service can commit them, a waiting queue grows. A fixed limit bounds the number of mutations waiting in memory and gives callers an explicit signal to slow down. It also makes overload visible through an error the application can handle.

One global queue admits up to 1,024 waiting gateway mutations, including creation and action calls. A full queue returns HTTP `503` with error tag `Overloaded` before executing the new call. Rejection changes no state, records no new receipt, and sends no messages. Retry later with the same idempotency key; the client surfaces the error for application-controlled retries. Draining a batch frees capacity. The active batch is separate from the waiting limit, and reads, watches, and durable message dispatch use their existing paths.

Admission happens before receipt lookup, so even a retry of a completed call can receive `503` while the queue is full. Existing receipts remain intact. See the [client](client.md) for retry behavior and [testing and performance](testing.md) for measurements.

[Documentation](README.md)
