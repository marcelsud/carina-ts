import { Schema } from "effect";
import { actor, action, query, service } from "carina";

const PositiveInt = Schema.Int.pipe(Schema.positive());
const Stock = Schema.Int.pipe(Schema.nonNegative());
const Status = Schema.Literal("new", "reserving", "reserved", "rejected");

export class InsufficientStock extends Schema.TaggedError<InsufficientStock>()("InsufficientStock", { available: Stock }) {}

const ProductState = Schema.Struct({ name: Schema.NonEmptyString, stock: Stock });
const ReserveForOrderInput = { qty: PositiveInt };
export const product = actor(ProductState)({
  errors: [InsufficientStock],
  actions: {
    reserve: action({ qty: PositiveInt }, ({ state }, { qty }) => {
      if (state.stock < qty) throw new InsufficientStock({ available: state.stock });
      state.stock -= qty;
      return { stock: state.stock };
    }),
    restock: action({ qty: PositiveInt }, ({ state }, { qty }) => {
      state.stock += qty;
      return { stock: state.stock };
    }),
  },
  internal: {
    reserveForOrder: action<typeof ReserveForOrderInput, null, typeof ProductState.Type>(ReserveForOrderInput, ({ state, caller, send }, { qty }) => {
      if (caller.kind !== "actor" || caller.type !== "order") throw new Error("Expected an order actor");
      const accepted = state.stock >= qty;
      if (accepted) state.stock -= qty;
      send.order(caller.key).reservationResult({ accepted });
      return null;
    }),
  },
});

const OrderState = Schema.Struct({ sku: Schema.NonEmptyString, qty: PositiveInt, status: Status });
export const order = actor(OrderState)({
  actions: {
    start: action({}, ({ state, send }) => {
      if (state.status === "new") {
        state.status = "reserving";
        send.product(state.sku).reserveForOrder({ qty: state.qty });
      }
      return { status: state.status };
    }),
  },
  internal: {
    reservationResult: action({ accepted: Schema.Boolean }, ({ state, caller }, { accepted }) => {
      if (caller.kind !== "actor" || caller.type !== "product" || caller.key !== state.sku) throw new Error("Expected the selected product actor");
      if (state.status === "reserving") state.status = accepted ? "reserved" : "rejected";
      return null;
    }),
  },
});

const CatalogRow = Schema.Struct({ key: Schema.String, name: Schema.String, stock: Stock });
export const shop = service({
  name: "shop", version: 1, actors: { product, order },
  queries: {
    catalog: query({ minStock: Stock }, ({ db }, { minStock }) => db.all(CatalogRow,
      `SELECT key,json_extract(state,'$.name') AS name,json_extract(state,'$.stock') AS stock
       FROM actors WHERE type='product' AND json_extract(state,'$.stock')>=? ORDER BY key LIMIT 1000`, [minStock])),
    orderStatus: query({ key: Schema.String }, ({ db }, { key }) => db.all(Schema.Struct({ status: Status }),
      `SELECT json_extract(state,'$.status') AS status FROM actors WHERE type='order' AND key=?`, [key])),
  },
});
export type Shop = typeof shop;
declare module "carina" { interface Register { service: Shop } }
export default shop;
