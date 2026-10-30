import { Schema } from "effect";
import { actor, action } from "carina";
import { client } from "carina/client";
import type { Shop } from "../examples/shop";

const State = Schema.Struct({ count: Schema.Int });
actor(State)({ actions: { increment: action({ qty: Schema.Int }, ({ state, send }, { qty }) => {
  state.count += qty;
  // @ts-expect-error actor state fields are typed
  state.missing = true;
  // @ts-expect-error actor state values are typed
  state.count = "wrong";
  // @ts-expect-error message payloads are typed
  send.product("p").reserveForOrder({ qty: "wrong" });
  // @ts-expect-error target actions are typed
  send.product("p").missing({});
  return { count: state.count };
}) } });

function clientTypes() {
  const shop = client<Shop>({ url: "http://localhost:7070" });
  shop.product("p").reserve({ qty: 1 }).then(reply => {
    const stock: number = reply.stock;
    // @ts-expect-error replies are typed
    const wrong: string = reply.stock;
    return stock;
  });
  // @ts-expect-error input is typed
  shop.product("p").reserve({ qty: "one" });
  // @ts-expect-error internal actions are absent from clients
  shop.product("p").reserveForOrder({ qty: 1 });
  // @ts-expect-error queries are typed
  shop.queries.catalog.query({ minStock: "one" });
  // @ts-expect-error initial state is typed
  shop.product.create("p", { name: "Hiking Boot", stock: "one" });
}
