import { start } from "workflow/api";
import { sleep } from "workflow";
import { routineState, fireRoutine } from "./routine-store";
import { recoveryWorkflow } from "./recovery-workflow";

export async function armRoutine(id: string, version: number) {
  const deadline = Date.now() + 30000;
  await start(routineWorkflow, [id, version]);
  return deadline;
}
export async function routineWorkflow(id: string, version: number) {
  "use workflow";
  // The timer is armed before SQL admission, so tolerate the short publish gap.
  for (let checks = 0; checks < 30; checks++) {
    const initial = await readState(id, version);
    if (initial && "missing" in initial) {
      await sleep("2s");
      continue;
    }
    if (!initial) return;
    break;
  }
  for (let runs = 0; runs < 10; runs++) {
    const state = await readState(id, version);
    if (!state || "missing" in state) return;
    const due = new Date(state.dueAt);
    if (due > new Date()) await sleep(due);
    // Arm recovery before admitting the occurrence/outbox transaction, too.
    const intent = { routineId: id, version, dueAt: state.dueAt };
    const deadline = Date.now() + 30000;
    await start(recoveryWorkflow, [
      state.conversationId,
      state.ownerId,
      intent,
    ]);
    await fire(id, version, state.dueAt, deadline);
  }
}
async function readState(id: string, version: number) {
  "use step";
  return routineState(id, version);
}
async function fire(
  id: string,
  version: number,
  dueAt: string,
  deadline: number,
) {
  "use step";
  return fireRoutine(id, version, dueAt, deadline);
}
