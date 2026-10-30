import type { Action, Actor, InputEncoded, Query, Service } from "./index";

export interface ClientOptions { url: string; accessKey?: string; retries?: number }
export interface MutationOptions { idempotencyKey?: string }
type Method<A> = A extends Action<infer I, infer R, any> ? (input: InputEncoded<I>, options?: MutationOptions) => Promise<R> : never;
type ActorClient<A> = A extends Actor<infer S, infer P, any> ? ((key: string) => { [K in keyof P]: Method<P[K]> }) & {
  create(key: string, input: import("effect").Schema.Schema.Encoded<S>, options?: MutationOptions): Promise<{ key: string }>;
} : never;
type QueryClient<Q> = Q extends Query<infer I, infer R> ? {
  query(input: InputEncoded<I>): Promise<R>;
  watch(input: InputEncoded<I>): AsyncIterableIterator<R>;
} : never;
export type Client<S extends Service> = { [K in keyof S["actors"]]: ActorClient<S["actors"][K]> } & {
  queries: { [K in keyof S["queries"]]: QueryClient<S["queries"][K]> };
};

class Watch<T> implements AsyncIterableIterator<T> {
  private socket?: WebSocket;
  private timer?: ReturnType<typeof setTimeout>;
  private ended = false;
  private failure?: unknown;
  private values: T[] = [];
  private waiting: { resolve: (result: IteratorResult<T>) => void; reject: (error: unknown) => void }[] = [];
  constructor(private options: ClientOptions, private name: string, private input: unknown) { this.connect(); }
  private connect() {
    if (this.ended) return;
    const url = new URL("/v1/ws", this.options.url);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = this.socket = new WebSocket(url);
    socket.onopen = () => socket.send(JSON.stringify({ op: "auth", accessKey: this.options.accessKey ?? "" }));
    socket.onmessage = event => {
      if (this.ended) return;
      try {
        const message = JSON.parse(String(event.data));
        if (message.op === "authenticated") socket.send(JSON.stringify({ op: "watch", id: "watch", query: this.name, input: this.input }));
        if (message.op === "result") {
          const pending = this.waiting.shift();
          if (pending) pending.resolve({ done: false, value: message.result });
          else this.values = [message.result];
        }
        if (message.op === "error") this.fail(message.error);
      } catch (error) { this.fail(error); }
    };
    socket.onerror = () => {};
    socket.onclose = () => { if (!this.ended) this.timer = setTimeout(() => this.connect(), 100); };
  }
  private fail(error: unknown) { this.failure = error; this.ended = true; clearTimeout(this.timer); this.socket?.close(); for (const waiter of this.waiting.splice(0)) waiter.reject(error); }
  [Symbol.asyncIterator]() { return this; }
  next(): Promise<IteratorResult<T>> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.values.length) return Promise.resolve({ done: false, value: this.values.shift()! });
    if (this.ended) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve, reject) => this.waiting.push({ resolve, reject }));
  }
  async return(): Promise<IteratorResult<T>> { this.ended = true; clearTimeout(this.timer); this.socket?.close(); this.values = []; for (const waiter of this.waiting.splice(0)) waiter.resolve({ done: true, value: undefined }); return { done: true, value: undefined }; }
}

export function client<S extends Service>(options: ClientOptions): Client<S> {
  async function request(path: string, input: unknown, mutation?: MutationOptions) {
    const key = mutation ? mutation.idempotencyKey ?? crypto.randomUUID() : undefined;
    const body = JSON.stringify(input);
    for (let attempt = 0;; attempt++) {
      let response: Response, value: any;
      try {
        response = await fetch(new URL(path, options.url), { method: "POST", headers: {
          "content-type": "application/json", authorization: `Bearer ${options.accessKey ?? ""}`,
          ...(key ? { "idempotency-key": key } : {}),
        }, body });
        value = await response.json();
      } catch (error) {
        if (attempt >= (options.retries ?? 2)) throw error;
        continue;
      }
      if (!response.ok) throw value.error;
      return key ? value.reply : value.result;
    }
  }
  const queries = new Proxy({}, { get: (_, name: string) => ({
    query: (input: unknown) => request(`/v1/queries/${encodeURIComponent(name)}`, input),
    watch: (input: unknown) => new Watch(options, name, input),
  }) });
  return new Proxy({}, { get: (_, type: string) => {
    if (type === "queries") return queries;
    if (type === "then") return undefined;
    const instance = (key: string) => new Proxy({}, { get: (_, action: string) => (input: unknown = {}, mutation: MutationOptions = {}) => request(`/v1/actors/${encodeURIComponent(type)}/${encodeURIComponent(key)}/actions/${encodeURIComponent(action)}`, input, mutation) });
    return Object.assign(instance, { create: (key: string, input: unknown, mutation: MutationOptions = {}) => request(`/v1/actors/${encodeURIComponent(type)}/${encodeURIComponent(key)}/create`, input, mutation) });
  } }) as Client<S>;
}
