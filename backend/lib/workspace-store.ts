import { assertSourceReferences } from "./source-store";
import { transaction } from "./agent-store";
import { assertWork } from "./work-store";
import { CapabilityError } from "./capability-contracts";
import { initialWorkspace, workspaceState } from "./workspace-policy";
export async function readWorkspace(owner: string, id: string) {
  return transaction(async (c) => {
    const raw = (
      await c.query(
        "SELECT conversation_id FROM agent_work WHERE id=$1 AND owner_id=$2",
        [id, owner],
      )
    ).rows[0];
    if (!raw) throw new CapabilityError("WORK_NOT_FOUND", 404);
    await c.query("SELECT id FROM agent_conversations WHERE id=$1 FOR UPDATE", [
      raw.conversation_id,
    ]);
    await assertWork(c, id, owner);
    const records = (
      await c.query(
        "SELECT id,title,source_id,source_version,source_index,revision,facts FROM structured_results WHERE work_id=$1 AND owner_id=$2 ORDER BY source_index",
        [id, owner],
      )
    ).rows;
    await assertSourceReferences(
      c,
      owner,
      records.map((r) => ({ id: r.source_id, version: r.source_version })),
    );
    const payments = (
      await c.query(
        "SELECT id,state,payload,digest,item_id,error_code,result_id,result_revision FROM sandbox_payment_proposals WHERE work_id=$1 AND owner_id=$2",
        [id, owner],
      )
    ).rows;
    const workspace = (
      await c.query(
        "SELECT revision,state FROM agent_workspaces WHERE work_id=$1 AND owner_id=$2",
        [id, owner],
      )
    ).rows[0] ?? { revision: 0, state: initialWorkspace() };
    const requests = (
      await c.query(
        "SELECT id,prompt,status,output,error_code,created_at FROM agent_workspace_requests WHERE work_id=$1 AND owner_id=$2 ORDER BY created_at LIMIT 30",
        [id, owner],
      )
    ).rows;
    return {
      workId: id,
      conversationId: raw.conversation_id,
      ...workspace,
      records,
      payments,
      requests,
    };
  });
}
export async function saveWorkspace(
  owner: string,
  id: string,
  expectedRevision: number,
  raw: unknown,
) {
  return transaction(async (c) => {
    const w = await assertWork(c, id, owner);
    const state = workspaceState.parse(raw);
    const current = (
      await c.query(
        "SELECT revision FROM agent_workspaces WHERE work_id=$1 FOR UPDATE",
        [id],
      )
    ).rows[0];
    if ((current?.revision ?? 0) !== expectedRevision)
      throw new CapabilityError("WORKSPACE_REVISION_CONFLICT", 409);
    const revision = expectedRevision + 1;
    await c.query(
      "INSERT INTO agent_workspaces(work_id,owner_id,revision,state) VALUES($1,$2,$3,$4) ON CONFLICT(work_id) DO UPDATE SET revision=$3,state=$4",
      [w.id, owner, revision, JSON.stringify(state)],
    );
    await c.query(
      "INSERT INTO agent_workspace_versions(work_id,revision,state) VALUES($1,$2,$3)",
      [w.id, revision, JSON.stringify(state)],
    );
    return { revision, state };
  });
}
