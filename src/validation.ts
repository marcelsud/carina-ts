import { Schema } from "effect";
import type { Actor, AnySchema } from "./index";

const statuses: Record<string, number> = { InvalidInput: 400, Unauthorized: 401, NotFound: 404, ActorExists: 409, IdempotencyConflict: 409, CompatibilityError: 409, DirectoryLocked: 409, Overloaded: 503 };
export class CarinaError extends Error {
  constructor(readonly _tag: string, message = _tag, readonly fields: Record<string, unknown> = {}, readonly status = statuses[_tag] ?? 500) { super(message); }
  toJSON() { return { _tag: this._tag, message: this.message, ...this.fields }; }
}
export function fail(tag: string, message?: string, fields?: Record<string, unknown>): never { throw new CarinaError(tag, message, fields); }
export function json(value: unknown): string {
  function check(v: unknown): void {
    if (v === null || typeof v === "string" || typeof v === "boolean") return;
    if (typeof v === "number" && Number.isFinite(v)) return;
    if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) check(v[i]); return; }
    if (typeof v === "object" && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null)) { for (const item of Object.values(v)) check(item); return; }
    throw new Error("Expected a JSON value");
  }
  // JSON.stringify catches cycles before recursive validation.
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("Expected a JSON value");
  check(value);
  return encoded;
}
export function canonical(value: unknown): string {
  json(value);
  const sort = (v: any): any => Array.isArray(v) ? v.map(sort) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sort(v[k])])) : v;
  return JSON.stringify(sort(value));
}
export function decode(schema: AnySchema, input: unknown) {
  const ast = schema.ast;
  if (ast._tag === "TypeLiteral" && !ast.propertySignatures.length && !ast.indexSignatures.length && (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length)) throw new Error("Expected an empty object");
  return Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(input);
}
export function encode(schema: AnySchema, value: unknown) { return json(Schema.encodeUnknownSync(schema, { onExcessProperty: "error" })(value)); }
export function inputValue(schema: AnySchema, input: unknown) {
  try { const value = decode(schema, input); return { value, encoded: canonical(JSON.parse(encode(schema, value))) }; }
  catch (e) { fail("InvalidInput", String(e)); }
}
export function upgradeStateJson(actor: Actor, type: string, key: string, version: number, encoded: string): string {
  if (!Number.isInteger(version) || version < 0 || version > actor.upgrades.length) fail("CompatibilityError", `Unsupported actor version: ${type}/${key}@${version}`);
  for (let n = version; n < actor.upgrades.length; n++) {
    const step = actor.upgrades[n]!;
    try { encoded = encode(step.to, step.run(decode(step.from, JSON.parse(encoded)))); }
    catch (e) { throw new CarinaError("UpgradeFailed", `Upgrade failed for ${type}/${key}`, { type, key, from: n, to: n + 1, diagnostic: String(e) }); }
  }
  return encoded;
}
export function actionError(error: unknown, actor: Actor): CarinaError {
  if (error instanceof CarinaError) return error;
  for (const declared of actor.errors) {
    try {
      const value = JSON.parse(json(Schema.encodeUnknownSync(declared)(error)));
      return new CarinaError(value._tag, value.message ?? value._tag, value, 422);
    } catch {}
  }
  console.error("Action failed:", error);
  return new CarinaError("ActionFailed", "Action execution or validation failed");
}
