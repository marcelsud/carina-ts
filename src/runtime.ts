import { Database } from "bun:sqlite";
import { mkdirSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { Schema } from "effect";
import { schemaOf, type Actor, type Caller, type ReadDatabase, type Service } from "./index";
import { actionError, CarinaError, decode, encode, fail, inputValue, json, upgradeStateJson } from "./validation";

const ddl = `
CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS actor_states (
  type TEXT NOT NULL, key TEXT NOT NULL, state TEXT NOT NULL,
  state_version INTEGER NOT NULL, PRIMARY KEY(type,key)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS receipts (
  type TEXT NOT NULL, key TEXT NOT NULL, request_id TEXT NOT NULL,
  action TEXT NOT NULL, input TEXT NOT NULL, reply TEXT NOT NULL, at INTEGER NOT NULL,
  PRIMARY KEY(type,key,request_id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_type TEXT NOT NULL, sender_key TEXT NOT NULL,
  target_type TEXT NOT NULL, target_key TEXT NOT NULL,
  action TEXT NOT NULL, input TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processed','failed','archived')),
  attempts INTEGER NOT NULL DEFAULT 0, error TEXT, created_at INTEGER NOT NULL,
  processed_at INTEGER, archived_at INTEGER, archive_reason TEXT
);
CREATE INDEX IF NOT EXISTS messages_pending ON messages(id) WHERE status='pending';
`;
type Message = { id: string; sender_type: string; sender_key: string; target_type: string; target_key: string; action: string; input: string };
type Outgoing = { type: string; key: string; action: string; input: string };
type StateRow = { state: string; state_version: number };
type QueuedCall = { run: () => unknown; resolve: (value: unknown) => void; reject: (error: unknown) => void };
const COMMIT_BATCH = 64;
const MAX_PENDING_CALLS = 1024;
const validName = (name: string) => /^[a-z][a-zA-Z0-9_-]*$/.test(name);
function keyCheck(key: string) { if (typeof key !== "string" || !key || Buffer.byteLength(key) > 256) fail("InvalidInput", "Instance keys must contain 1 to 256 UTF-8 bytes"); }
function own<T>(map: Record<string, T>, name: string): T | undefined { return Object.hasOwn(map, name) ? map[name] : undefined; }

export class Runtime {
  readonly directory: string;
  readonly path: string;
  db!: Database;
  private reader!: Database;
  private lock!: Database;
  private closed = false;
  private dispatchTimer?: ReturnType<typeof setTimeout>;
  private dispatchEnabled = false;
  private listeners = new Set<() => void>();
  private pendingCalls: QueuedCall[] = [];
  private flushTimer?: ReturnType<typeof setImmediate>;
  private deferredNotify = false;

  constructor(readonly service: Service, directory: string, options: { maintenance?: boolean } = {}) {
    this.directory = resolve(directory);
    this.path = join(this.directory, "carina.db");
    mkdirSync(this.directory, { recursive: true });
    try {
      this.lock = new Database(join(this.directory, ".lock"));
      this.lock.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE");
    } catch { this.lock?.close(); fail("DirectoryLocked", `Data directory is locked: ${this.directory}`); }
    try {
      this.validateDefinitions();
      this.openData();
      if (!options.maintenance) this.checkCompatibility();
    } catch (e) { this.close(); throw e; }
  }

  private validateDefinitions() {
    if (!/^[a-z][a-z0-9-]*$/.test(this.service.name) || !Number.isSafeInteger(this.service.version) || this.service.version < 1) fail("CompatibilityError", "Invalid service name or storage version");
    for (const [type, actor] of Object.entries(this.service.actors)) {
      if (!validName(type)) fail("CompatibilityError", `Invalid actor name: ${type}`);
      for (const action of [...Object.keys(actor.actions), ...Object.keys(actor.internal)]) if (!validName(action)) fail("CompatibilityError", `Invalid action name: ${action}`);
      for (const action of Object.keys(actor.actions)) if (Object.hasOwn(actor.internal, action)) fail("CompatibilityError", `Action appears in both maps: ${type}.${action}`);
      actor.upgrades.forEach((step, n) => {
        const next = actor.upgrades[n + 1]?.from ?? actor.state;
        if (step.to.ast !== next.ast) fail("CompatibilityError", `Reuse the destination schema as the next source schema: ${type} upgrade ${n}`);
      });
    }
    for (const name of Object.keys(this.service.queries)) if (!validName(name)) fail("CompatibilityError", `Invalid query name: ${name}`);
  }

  private openData() {
    this.db = new Database(this.path, { strict: true });
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000");
    this.db.transaction(() => {
      this.db.exec(ddl);
      this.db.query("INSERT OR IGNORE INTO metadata VALUES ('service', ?)").run(this.service.name);
      this.db.query("INSERT OR IGNORE INTO metadata VALUES ('version', ?)").run(String(this.service.version));
    }).immediate();
    const name = (this.db.query("SELECT value FROM metadata WHERE key='service'").get() as any).value;
    if (name !== this.service.name) fail("CompatibilityError", `Directory belongs to service ${name}`);
    this.reader = new Database(this.path, { readonly: true, strict: true });
    if (typeof this.reader.function !== "function") fail("CompatibilityError", "This Bun runtime requires Database.function()");
    this.reader.function("carina_state", (type: string, key: string, version: number, encoded: string) => {
      const actor = this.definition(type);
      return upgradeStateJson(actor, type, key, version, encoded);
    });
    this.reader.exec(`CREATE TEMP VIEW actors AS SELECT type,key,carina_state(type,key,state_version,state) AS state FROM main.actor_states`);
    this.reader.exec("PRAGMA query_only=ON");
  }

  private definition(type: string): Actor {
    return own(this.service.actors, type) ?? fail("NotFound", `Actor type not found: ${type}`);
  }
  private action(type: string, name: string, internal: boolean) {
    const actor = this.definition(type);
    const definition = own(actor.actions, name) ?? (internal ? own(actor.internal, name) : undefined);
    if (!definition) fail("NotFound", `Action not found: ${type}.${name}`);
    return definition;
  }
  private storageVersion() { return Number((this.db.query("SELECT value FROM metadata WHERE key='version'").get() as any).value); }

  checkCompatibility() {
    if (this.storageVersion() !== this.service.version) fail("CompatibilityError", "Storage version differs; run migrate with the matching executable");
    for (const row of this.db.query("SELECT type,max(state_version) AS version,min(state_version) AS minimum FROM actor_states GROUP BY type").all() as any[]) {
      const actor = own(this.service.actors, row.type);
      if (!actor || row.version > actor.upgrades.length || row.minimum < 0) fail("CompatibilityError", `Unsupported stored actor version: ${row.type}`);
    }
    for (const row of this.db.query("SELECT CAST(id AS TEXT) AS id,target_type,target_key,action,input FROM messages WHERE status='pending'").all() as any[]) {
      try { inputValue(schemaOf(this.action(row.target_type, row.action, true).input), JSON.parse(row.input)); }
      catch (e) { fail("CompatibilityError", `Pending message ${row.id} is incompatible`, { messageId: row.id, diagnostic: String(e) }); }
    }
  }

  private outgoing(senderType: string, senderKey: string, sends: Outgoing[], now: number) {
    const insert = this.db.query("INSERT INTO messages(sender_type,sender_key,target_type,target_key,action,input,created_at) VALUES (?,?,?,?,?,?,?)");
    for (const send of sends) insert.run(senderType, senderKey, send.type, send.key, send.action, send.input, now);
  }
  private sendContext(sends: Outgoing[]) {
    return new Proxy({}, { get: (_, type: string) => (key: string) => new Proxy({}, {
      get: (_, name: string) => (input: unknown) => {
        keyCheck(key);
        const definition = this.action(type, name, true);
        const normalized = inputValue(schemaOf(definition.input), input);
        sends.push({ type, key, action: name, input: normalized.encoded });
      },
    }) });
  }
  private execute(type: string, key: string, name: string, input: unknown, caller: Caller, messageId?: string) {
    const actor = this.definition(type), definition = this.action(type, name, caller.kind === "actor");
    const normalized = inputValue(schemaOf(definition.input), input);
    const row = this.db.query("SELECT state,state_version FROM actor_states WHERE type=? AND key=?").get(type, key) as StateRow | null;
    if (!row) fail("NotFound", `Instance not found: ${type}/${key}`);
    const encoded = upgradeStateJson(actor, type, key, row.state_version, row.state);
    const now = Date.now(), sends: Outgoing[] = [];
    try {
      const state = decode(actor.state, JSON.parse(encoded));
      const reply = definition.run({ state, key, now, caller, messageId, send: this.sendContext(sends) as any }, normalized.value);
      const result = json(reply);
      const stateJSON = encode(actor.state, state);
      this.db.query("UPDATE actor_states SET state=?,state_version=? WHERE type=? AND key=?").run(stateJSON, actor.upgrades.length, type, key);
      this.outgoing(type, key, sends, now);
      return result;
    } catch (e) { throw actionError(e, actor); }
  }

  call(type: string, key: string, name: string, input: unknown, requestId: string, create = false): unknown {
    keyCheck(key);
    if (!requestId || Buffer.byteLength(requestId) > 256) fail("InvalidInput", "A request ID must contain 1 to 256 bytes");
    const actor = this.definition(type);
    const normalized = inputValue(create ? actor.state : schemaOf(this.action(type, name, false).input), input);
    const operation = create ? "@create" : name;
    let changed = false;
    const result = this.db.transaction(() => {
      const old = this.db.query("SELECT action,input,reply FROM receipts WHERE type=? AND key=? AND request_id=?").get(type, key, requestId) as any;
      if (old) {
        if (old.action !== operation || old.input !== normalized.encoded) fail("IdempotencyConflict");
        return old.reply as string;
      }
      let reply: string;
      if (create) {
        if (this.db.query("SELECT 1 FROM actor_states WHERE type=? AND key=?").get(type, key)) fail("ActorExists");
        this.db.query("INSERT INTO actor_states VALUES (?,?,?,?)").run(type, key, encode(actor.state, normalized.value), actor.upgrades.length);
        reply = json({ key });
      } else reply = this.execute(type, key, name, JSON.parse(normalized.encoded), { kind: "client" });
      this.db.query("INSERT INTO receipts VALUES (?,?,?,?,?,?,?)").run(type, key, requestId, operation, normalized.encoded, reply, Date.now());
      changed = true;
      return reply;
    }).immediate();
    if (changed) this.notify();
    return JSON.parse(result);
  }

  submit(type: string, key: string, name: string, input: unknown, requestId: string, create = false): Promise<unknown> {
    if (this.closed) return Promise.reject(new CarinaError("ActionFailed", "Runtime is closed"));
    if (this.pendingCalls.length >= MAX_PENDING_CALLS) return Promise.reject(new CarinaError("Overloaded", "Mutation queue is full"));
    return new Promise((resolve, reject) => {
      this.pendingCalls.push({ run: () => this.call(type, key, name, input, requestId, create), resolve, reject });
      this.scheduleFlush();
    });
  }
  private scheduleFlush() {
    if (this.flushTimer || !this.pendingCalls.length) return;
    this.flushTimer = setImmediate(() => {
      this.flushTimer = undefined;
      const calls = this.pendingCalls.splice(0, COMMIT_BATCH);
      const outcomes: ({ value: unknown } | { error: unknown })[] = [];
      try {
        // Bun's nested transactions use savepoints, so one rejected action
        // rolls back its own work while ready calls share a durable commit.
        this.commitBatch(() => {
          for (const call of calls) {
            try { outcomes.push({ value: call.run() }); }
            catch (error) { outcomes.push({ error }); }
          }
        });
        calls.forEach((call, i) => { const result = outcomes[i]!; if ("error" in result) call.reject(result.error); else call.resolve(result.value); });
      } catch (error) {
        console.error("Batch commit failed:", error);
        for (const call of calls) call.reject(new CarinaError("ActionFailed", "Batch commit failed"));
      }
      this.scheduleFlush();
    });
  }
  private commitBatch<T>(run: () => T): T {
    const previous = this.deferredNotify;
    try {
      const result = this.db.transaction(run).immediate();
      if (!this.db.inTransaction && this.deferredNotify) { this.deferredNotify = false; this.notify(); }
      return result;
    } catch (error) { this.deferredNotify = previous; throw error; }
  }

  query(name: string, input: unknown): unknown {
    const definition = own(this.service.queries, name) ?? fail("NotFound", `Query not found: ${name}`);
    const normalized = inputValue(schemaOf(definition.input), input);
    const adapter: ReadDatabase = { all: (schema, sql, params = []) => this.reader.query(sql).all(...params).map(row => decode(schema, row)) };
    try { return this.reader.transaction(() => JSON.parse(json(definition.run({ db: adapter }, normalized.value))))(); }
    catch (e) { if (e instanceof CarinaError) throw e; console.error("Query failed:", e); throw new CarinaError("QueryFailed", "Query execution or validation failed"); }
  }

  deliverOne(id?: string): boolean {
    let message: Message | null = null;
    try {
      const delivered = this.db.transaction(() => {
        const select = "SELECT CAST(id AS TEXT) AS id,sender_type,sender_key,target_type,target_key,action,input FROM messages WHERE status='pending'";
        message = (id === undefined ? this.db.query(`${select} ORDER BY id LIMIT 1`).get() : this.db.query(`${select} AND id=?`).get(id)) as Message | null;
        if (!message) return false;
        this.execute(message.target_type, message.target_key, message.action, JSON.parse(message.input), { kind: "actor", type: message.sender_type, key: message.sender_key }, message.id);
        this.db.query("UPDATE messages SET status='processed',attempts=attempts+1,processed_at=?,error=NULL WHERE id=? AND status='pending'").run(Date.now(), message.id);
        return true;
      }).immediate();
      if (delivered) this.notify();
      return delivered;
    } catch (e) {
      // A confirmed action rollback can be recorded as a failure. Storage errors
      // are recovered by reopening and checking the row before another attempt.
      if (!(e instanceof CarinaError) || !message) throw e;
      this.db.transaction(() => this.db.query("UPDATE messages SET status='failed',attempts=attempts+1,error=? WHERE id=? AND status='pending'").run(json(e.toJSON()), (message as Message).id)).immediate();
      return true;
    }
  }
  private deliverBatch(): boolean {
    // Snapshot only committed messages. Responses inserted by these turns
    // become eligible in the next batch, after their sender commits.
    const pending = this.db.query(`SELECT CAST(id AS TEXT) AS id FROM messages WHERE status='pending' ORDER BY id LIMIT ${COMMIT_BATCH}`).all() as { id: string }[];
    if (!pending.length) return false;
    return this.commitBatch(() => { for (const message of pending) this.deliverOne(message.id); return true; });
  }
  startDispatch() { this.dispatchEnabled = true; this.kick(); }
  private kick(delay = 0) {
    if (!this.dispatchEnabled || this.closed || this.dispatchTimer) return;
    this.dispatchTimer = setTimeout(() => {
      this.dispatchTimer = undefined;
      try { if (this.deliverBatch()) this.kick(); }
      catch (e) {
        console.error("Dispatcher recovering after database error:", e);
        try { this.reader?.close(); this.db?.close(); this.openData(); this.checkCompatibility(); }
        catch (recovery) { console.error("Database recovery failed:", recovery); }
        this.kick(1000);
      }
    }, delay);
  }
  onCommit(callback: () => void) { this.listeners.add(callback); return () => { this.listeners.delete(callback); }; }
  private notify() {
    if (this.db.inTransaction) { this.deferredNotify = true; return; }
    for (const listener of this.listeners) { try { listener(); } catch (e) { console.error(e); } }
    this.kick();
  }

  inspect(type: string, key: string) { return this.db.query("SELECT type,key,state,state_version FROM actor_states WHERE type=? AND key=?").get(type, key) ?? fail("NotFound"); }
  messages(status?: string) { return status ? this.db.query("SELECT *,CAST(id AS TEXT) AS id FROM messages WHERE status=? ORDER BY id").all(status) : this.db.query("SELECT *,CAST(id AS TEXT) AS id FROM messages ORDER BY id").all(); }
  retry(id: string) {
    this.db.transaction(() => {
      const row = this.db.query("SELECT * FROM messages WHERE id=? AND status='failed'").get(id) as any;
      if (!row) fail("InvalidInput", "Only failed messages can be retried");
      inputValue(schemaOf(this.action(row.target_type, row.action, true).input), JSON.parse(row.input));
      this.db.query("UPDATE messages SET status='pending',error=NULL WHERE id=?").run(id);
    }).immediate();
  }
  archive(id: string, reason: string) {
    if (!reason.trim()) fail("InvalidInput", "An archive reason is required");
    const result = this.db.query("UPDATE messages SET status='archived',archived_at=?,archive_reason=? WHERE id=? AND status<>'archived'").run(Date.now(), reason, id);
    if (!result.changes) fail("NotFound", "Message does not exist or is already archived");
  }
  migrate() {
    this.db.transaction(() => {
      let version = this.storageVersion();
      if (version > this.service.version) fail("CompatibilityError", "Database storage version is newer than the executable");
      while (version < this.service.version) {
        const migration = this.service.migrations.find(m => m.from === version && m.to === version + 1);
        if (!migration) fail("CompatibilityError", `Missing migration ${version} -> ${version + 1}`);
        const result = migration.run(this.db) as unknown;
        if (result && typeof (result as any).then === "function") fail("CompatibilityError", "Migrations must be synchronous");
        version++;
      }
      for (const row of this.db.query("SELECT * FROM actor_states").all() as any[]) {
        const actor = this.definition(row.type);
        const state = upgradeStateJson(actor, row.type, row.key, row.state_version, row.state);
        const validated = encode(actor.state, decode(actor.state, JSON.parse(state)));
        this.db.query("UPDATE actor_states SET state=?,state_version=? WHERE type=? AND key=?").run(validated, actor.upgrades.length, row.type, row.key);
      }
      this.db.query("UPDATE metadata SET value=? WHERE key='version'").run(String(version));
      this.checkCompatibility();
    }).immediate();
  }
  async backup(destination: string) {
    mkdirSync(destination, { recursive: true });
    const target = join(resolve(destination), "carina.db");
    if (existsSync(target)) fail("InvalidInput", "Backup destination already contains carina.db");
    const { DatabaseSync, backup } = await import("node:sqlite");
    const source = new DatabaseSync(this.path, { readOnly: true });
    try { await backup(source, target); } finally { source.close(); }
    return target;
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.dispatchTimer) clearTimeout(this.dispatchTimer);
    if (this.flushTimer) clearImmediate(this.flushTimer);
    for (const call of this.pendingCalls.splice(0)) call.reject(new CarinaError("ActionFailed", "Runtime closed before commit"));
    this.reader?.close(); this.db?.close(); this.lock?.close();
    this.listeners.clear();
  }
}
