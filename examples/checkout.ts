import { client } from "carina/client";
import type { Shop } from "./shop";

const shop = client<Shop>({ url: "http://127.0.0.1:7070", accessKey: process.env.CARINA_ACCESS_KEY ?? "dev" });
await shop.product.create("sku-1", { name: "Hiking Boot", stock: 10 }, { idempotencyKey: "create-product" });
await shop.order.create("o-1", { sku: "sku-1", qty: 2, status: "new" }, { idempotencyKey: "create-order" });
await shop.order("o-1").start({}, { idempotencyKey: "start-order" });
for await (const rows of shop.queries.orderStatus.watch({ key: "o-1" })) {
  console.log(rows);
  if (rows[0]?.status === "reserved" || rows[0]?.status === "rejected") break;
}
console.log(await shop.queries.catalog.query({ minStock: 0 }));
