import { reserveModelBudgetCore } from "./model-budget-core";
export async function reserveModelBudget(model: string) {
  "use step";
  return reserveModelBudgetCore(model);
}
