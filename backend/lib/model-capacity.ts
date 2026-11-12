import { sleep } from "workflow";
import { reserveModelCapacityCore } from "./model-capacity-core";
export async function waitForModelCapacity(model: string) {
  const wait = await reserveModelCall(model);
  if (wait > 0) await sleep(wait);
}
export async function reserveModelCall(model: string) {
  "use step";
  return reserveModelCapacityCore(model);
}
