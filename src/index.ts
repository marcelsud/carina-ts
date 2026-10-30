import { Schema } from "effect";

export type AnySchema = Schema.Schema<any, any, never>;
export type Input = AnySchema | Schema.Struct.Fields;
export type InputType<I> = I extends AnySchema ? Schema.Schema.Type<I> : I extends Schema.Struct.Fields ? Schema.Struct.Type<I> : never;
export type InputEncoded<I> = I extends AnySchema ? Schema.Schema.Encoded<I> : I extends Schema.Struct.Fields ? Schema.Struct.Encoded<I> : never;
export type Draft<T> = T extends readonly (infer A)[] ? Draft<A>[] : T extends object ? { -readonly [K in keyof T]: Draft<T[K]> } : T;
export interface Register {}
export type RegisteredService = Register extends { service: infer S } ? S : Service;
type SendAction<A> = A extends { input: infer I extends Input } ? (input: InputEncoded<I>) => void : never;
export type Send<S> = S extends { actors: infer A } ? {
  [T in keyof A]: (key: string) => A[T] extends { actions: infer P; internal: infer N } ? { [K in keyof P | keyof N]: SendAction<(P & N)[K]> } : never;
} : never;
export type Caller = { kind: "client" } | { kind: "actor"; type: string; key: string };
interface BaseContext<S> {
  state: Draft<S>;
  key: string;
  now: number;
  caller: Caller;
  messageId?: string;
}
export interface ActionContext<S> extends BaseContext<S> { send: Send<RegisteredService> }
export interface Action<I extends Input = any, R = any, S = any> {
  input: I;
  run: (context: any, input: any) => R;
  readonly _state?: S;
}
export function action<I extends Input, R, S = any>(input: I, run: (context: ActionContext<S>, input: InputType<I>) => R): Action<I, R, S> {
  return { input, run };
}
export type ActionMap<S = any> = Record<string, Action<any, any, S>>;
export interface Upgrade {
  from: AnySchema;
  to: AnySchema;
  run: (state: any) => any;
}
export function upgrade<F extends AnySchema, T extends AnySchema>(from: F, to: T, run: (state: Schema.Schema.Type<F>) => Schema.Schema.Type<T>): Upgrade {
  return { from, to, run };
}
export interface Actor<S extends AnySchema = AnySchema, A extends ActionMap = ActionMap, N extends ActionMap = ActionMap> {
  state: S;
  actions: A;
  internal: N;
  errors: readonly AnySchema[];
  upgrades: readonly Upgrade[];
}
type ActorOptions<S extends AnySchema, A extends ActionMap = {}, N extends ActionMap = {}> = {
  state: S;
  actions?: A & ActionMap<Schema.Schema.Type<S>>;
  internal?: N & ActionMap<Schema.Schema.Type<S>>;
  errors?: readonly AnySchema[];
  upgrades?: readonly Upgrade[];
};
export function actor<S extends AnySchema>(schema: S): <A extends ActionMap<Schema.Schema.Type<S>> = {}, N extends ActionMap<Schema.Schema.Type<S>> = {}>(options: Omit<ActorOptions<S, A, N>, "state">) => Actor<S, A, N>;
export function actor<S extends AnySchema, A extends ActionMap<Schema.Schema.Type<S>> = {}, N extends ActionMap<Schema.Schema.Type<S>> = {}>(options: ActorOptions<S, A, N>): Actor<S, A, N>;
export function actor(options: AnySchema | ActorOptions<AnySchema, ActionMap, ActionMap>): any {
  if (Schema.isSchema(options)) return (rest: any) => actor({ ...rest, state: options });
  return { ...options, actions: options.actions ?? {}, internal: options.internal ?? {}, errors: options.errors ?? [], upgrades: options.upgrades ?? [] };
}
export interface ReadDatabase {
  all<S extends AnySchema>(schema: S, sql: string, params?: readonly (string | number | bigint | boolean | null | Uint8Array)[]): Schema.Schema.Type<S>[];
}
export interface Query<I extends Input = any, R = any> {
  input: I;
  run: (context: { db: ReadDatabase }, input: InputType<I>) => R;
}
export function query<I extends Input, R>(input: I, run: (context: { db: ReadDatabase }, input: InputType<I>) => R): Query<I, R> {
  return { input, run };
}
export interface Migration {
  from: number;
  to: number;
  run: (db: import("bun:sqlite").Database) => void;
}
export interface Service<A extends Record<string, Actor> = Record<string, Actor>, Q extends Record<string, Query> = Record<string, Query>> {
  name: string;
  version: number;
  actors: A;
  queries: Q;
  migrations: readonly Migration[];
}
export function service<A extends Record<string, Actor>, Q extends Record<string, Query> = {}>(options: {
  name: string; version: number; actors: A; queries?: Q; migrations?: readonly Migration[];
}): Service<A, Q> {
  return { ...options, queries: options.queries ?? {} as Q, migrations: options.migrations ?? [] };
}
export const schemaOf = (input: Input): AnySchema => Schema.isSchema(input) ? input : Schema.Struct(input) as unknown as AnySchema;
