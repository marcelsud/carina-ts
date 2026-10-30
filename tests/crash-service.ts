import { existsSync, unlinkSync } from "node:fs";
import shop from "../examples/shop";
import { service } from "carina";

const reserve = shop.actors.product.internal.reserveForOrder;
export default service({ ...shop, actors: { ...shop.actors, product: {
  ...shop.actors.product,
  internal: { reserveForOrder: { ...reserve, run(context: any, input: any) {
    const result = reserve.run(context, input);
    const marker = process.env.CARINA_TEST_CRASH_MARKER;
    const target = process.env.CARINA_TEST_CRASH_TARGET;
    if (marker && existsSync(marker) && (!target || context.key === target)) {
      unlinkSync(marker);
      process.kill(process.pid, "SIGKILL");
    }
    return result;
  } } },
} } });
