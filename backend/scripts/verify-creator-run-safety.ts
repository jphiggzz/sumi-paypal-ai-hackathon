import { commitCreatorTurn } from "../lib/creator/store";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { authPool } from "../lib/auth";
import { initialCampaign } from "../lib/creator/policy";
import { creators } from "../lib/creator/catalog";
import {
  completeCreatorRun,
  recordCreatorProgress,
} from "../lib/creator/workflow";
const user = `creator-safety-${randomUUID()}`,
  cid = randomUUID(),
  oldId = randomUUID(),
  newId = randomUUID(),
  oldAttempt = randomUUID(),
  newAttempt = randomUUID();
const brief = {
  ...initialCampaign().brief,
  brand: "Sample",
  audience: "developers" as const,
};
const input = {
  brief,
  reply: "Find creators",
  options: [],
  next: "compare",
  sources: [],
  candidates: [],
  catalog: creators,
};
const candidate = {
  id: "api-educator",
  reason: "Sample API evidence",
  evidenceIndexes: [0],
};
try {
  await authPool.query(
    'INSERT INTO auth_users(id,name,email,"emailVerified") VALUES($1,$2,$3,false)',
    [user, "Safety test", `${user}@example.invalid`],
  );
  await authPool.query(
    "INSERT INTO workspace_chats(id,owner_id,mode) VALUES($1,$2,'creators')",
    [cid, user],
  );
  for (const id of [oldId, newId])
    await authPool.query(
      "INSERT INTO workspace_chat_messages(id,conversation_id,role,content,mode,status) VALUES($1,$2,'assistant','Find creators','creators','completed')",
      [id, cid],
    );
  const state = { ...initialCampaign(), brief, revision: 2 };
  await authPool.query(
    "INSERT INTO creator_campaigns(conversation_id,state) VALUES($1,$2)",
    [cid, JSON.stringify(state)],
  );
  await authPool.query(
    "INSERT INTO creator_runs(id,conversation_id,message_id,revision,status,input,attempt) VALUES($1,$2,$1,1,'running',$3,$4)",
    [oldId, cid, JSON.stringify(input), oldAttempt],
  );
  await completeCreatorRun(oldId, randomUUID(), [candidate.id], [candidate]);
  assert.equal(
    (
      await authPool.query("SELECT status FROM creator_runs WHERE id=$1", [
        oldId,
      ])
    ).rows[0].status,
    "running",
  );
  await recordCreatorProgress(oldId, oldAttempt, "Scout", "Selected", [
    candidate.id,
  ]);
  await recordCreatorProgress(oldId, oldAttempt, "Scout", "Selected", [
    candidate.id,
  ]);
  assert.equal(
    (
      await authPool.query(
        "SELECT jsonb_array_length(activity) n FROM creator_runs WHERE id=$1",
        [oldId],
      )
    ).rows[0].n,
    1,
  );
  await completeCreatorRun(oldId, oldAttempt, [candidate.id], [candidate]);
  const stale = (
    await authPool.query("SELECT status,result FROM creator_runs WHERE id=$1", [
      oldId,
    ])
  ).rows[0];
  assert.equal(stale.status, "stale");
  assert.equal(stale.result.candidates[0].id, candidate.id);
  assert.equal(stale.result.profiles[0].name, "Alex Morgan");
  assert.deepEqual(
    (
      await authPool.query(
        "SELECT state FROM creator_campaigns WHERE conversation_id=$1",
        [cid],
      )
    ).rows[0].state.candidates,
    [],
  );
  await authPool.query(
    "INSERT INTO creator_runs(id,conversation_id,message_id,revision,status,input,attempt) VALUES($1,$2,$1,2,'running',$3,$4)",
    [newId, cid, JSON.stringify(input), newAttempt],
  );
  await completeCreatorRun(newId, newAttempt, [candidate.id], [candidate]);
  const ready = (
    await authPool.query("SELECT status,result FROM creator_runs WHERE id=$1", [
      newId,
    ])
  ).rows[0];
  assert.equal(ready.status, "ready");
  assert.equal(
    (
      await authPool.query(
        "SELECT state FROM creator_campaigns WHERE conversation_id=$1",
        [cid],
      )
    ).rows[0].state.candidates[0].id,
    candidate.id,
  );
  await completeCreatorRun(newId, newAttempt, [], []);
  assert.deepEqual(
    (
      await authPool.query("SELECT result FROM creator_runs WHERE id=$1", [
        newId,
      ])
    ).rows[0].result,
    ready.result,
  );
  const legacyCid = randomUUID(),
    legacyMessage = randomUUID(),
    nextMessage = randomUUID();
  await authPool.query(
    "INSERT INTO workspace_chats(id,owner_id,mode) VALUES($1,$2,'creators')",
    [legacyCid, user],
  );
  await authPool.query(
    "INSERT INTO workspace_chat_messages(id,conversation_id,role,content,mode,status) VALUES($1,$2,'assistant','Earlier shortlist','creators','completed'),($3,$2,'assistant','','creators','streaming')",
    [legacyMessage, legacyCid, nextMessage],
  );
  const legacyState = {
    ...initialCampaign(),
    brief,
    revision: 5,
    candidates: [candidate],
    previous: [{ ...candidate, id: "deployment-builder" }],
    lastReplyId: legacyMessage,
  };
  await authPool.query(
    "INSERT INTO creator_campaigns(conversation_id,state) VALUES($1,$2)",
    [legacyCid, JSON.stringify(legacyState)],
  );
  await commitCreatorTurn(user, legacyCid, nextMessage, 5, input as any);
  const legacyRuns = (
    await authPool.query(
      "SELECT id,status,result FROM creator_runs WHERE conversation_id=$1 ORDER BY created_at,id",
      [legacyCid],
    )
  ).rows;
  assert.equal(legacyRuns.length, 2);
  const prior = legacyRuns.find((r) => r.id === legacyMessage),
    next = legacyRuns.find((r) => r.id === nextMessage);
  assert.equal(prior.status, "ready");
  assert.equal(prior.result.legacy, true);
  assert.equal(prior.result.candidates[0].id, candidate.id);
  assert.equal(prior.result.previous[0].id, "deployment-builder");
  assert.equal(next.status, "queued");
  const backfillCid = randomUUID(), backfillMessage = randomUUID();
  await authPool.query("INSERT INTO workspace_chats(id,owner_id,mode) VALUES($1,$2,'creators')", [backfillCid, user]);
  await authPool.query("INSERT INTO workspace_chat_messages(id,conversation_id,role,content,mode,status) VALUES($1,$2,'assistant','Earlier shortlist','creators','completed')", [backfillMessage, backfillCid]);
  await authPool.query("INSERT INTO creator_campaigns(conversation_id,state) VALUES($1,$2)", [backfillCid, JSON.stringify({ ...legacyState, lastReplyId: backfillMessage })]);
  const migration = (await readFile(new URL("./migrations/042_legacy_creator_history.sql", import.meta.url), "utf8")).replace("ON CONFLICT (id)", "AND c.conversation_id = $1\nON CONFLICT (id)");
  await authPool.query(migration, [backfillCid]);
  await authPool.query(migration, [backfillCid]);
  const backfill = (await authPool.query("SELECT message_id,result FROM creator_runs WHERE conversation_id=$1", [backfillCid])).rows;
  assert.equal(backfill.length, 1);
  assert.equal(backfill[0].message_id, backfillMessage);
  assert.equal(backfill[0].result.previous[0].id, "deployment-builder");
  const draftCid = randomUUID(), draftId = randomUUID(), sameId = randomUUID(), changedId = randomUUID();
  await authPool.query("INSERT INTO workspace_chats(id,owner_id,mode) VALUES($1,$2,'creators')", [draftCid, user]);
  for (const id of [draftId, sameId, changedId]) {
    await authPool.query("INSERT INTO workspace_chat_messages(id,conversation_id,role,content,mode,status) VALUES($1,$2,'assistant','','creators','streaming')", [id, draftCid]);
  }
  const site = { url: "https://example.com/", title: "Example", excerpt: "An example product." };
  await authPool.query("INSERT INTO creator_campaigns(conversation_id,state) VALUES($1,$2)", [draftCid, JSON.stringify({ ...initialCampaign(), brief, revision: 1, setup: { websiteOffered: true, website: site } })]);
  await commitCreatorTurn(user, draftCid, draftId, 1, input as any, false, { websiteOffered: true, website: site }, true);
  assert.equal((await authPool.query("SELECT status FROM creator_runs WHERE id=$1", [draftId])).rows[0].status, "draft");
  const explain = { ...input, next: "explain" as const };
  await commitCreatorTurn(user, draftCid, sameId, 2, explain, false, { websiteOffered: true, website: site });
  assert.deepEqual((await authPool.query("SELECT status,revision FROM creator_runs WHERE id=$1", [draftId])).rows[0], { status: "draft", revision: 3 });
  await commitCreatorTurn(user, draftCid, changedId, 3, explain, false, { websiteOffered: true, website: { ...site, excerpt: "Updated product." } });
  assert.equal((await authPool.query("SELECT status FROM creator_runs WHERE id=$1", [draftId])).rows[0].status, "stale");
  const replacementCid = randomUUID(), replacementId = randomUUID(), attempt = randomUUID();
  const retained = { id: "deployment-builder", reason: "Deployment", evidenceIndexes: [0] };
  const replacementCandidate = { id: "react-educator", reason: "React", evidenceIndexes: [0] };
  await authPool.query("INSERT INTO workspace_chats(id,owner_id,mode) VALUES($1,$2,'creators')", [replacementCid, user]);
  await authPool.query("INSERT INTO workspace_chat_messages(id,conversation_id,role,content,mode,status) VALUES($1,$2,'assistant','','creators','streaming')", [replacementId, replacementCid]);
  await authPool.query("INSERT INTO creator_campaigns(conversation_id,state) VALUES($1,$2)", [replacementCid, JSON.stringify({ ...initialCampaign(), brief, revision: 1, candidates: [candidate, retained] })]);
  await commitCreatorTurn(user, replacementCid, replacementId, 1, { ...input, candidates: [retained] } as any, false, undefined, true, false, true);
  const draft = (await authPool.query("SELECT status,input FROM creator_runs WHERE id=$1", [replacementId])).rows[0];
  assert.equal(draft.status, "draft");
  assert.deepEqual(draft.input.seenIds, [candidate.id, retained.id]);
  assert.deepEqual(draft.input.retainedCandidates, [retained]);
  await authPool.query("UPDATE creator_runs SET status='running',attempt=$2 WHERE id=$1", [replacementId, attempt]);
  await completeCreatorRun(replacementId, attempt, [replacementCandidate.id], [replacementCandidate]);
  const replacementResult = (await authPool.query("SELECT result FROM creator_runs WHERE id=$1", [replacementId])).rows[0].result;
  assert.deepEqual(replacementResult.candidates.map((c: any) => c.id), [retained.id, replacementCandidate.id]);
  assert.equal(replacementResult.replacementAdded, 1);
  const emptyId = randomUUID(), emptyAttempt = randomUUID();
  await authPool.query("INSERT INTO workspace_chat_messages(id,conversation_id,role,content,mode,status) VALUES($1,$2,'assistant','','creators','completed')", [emptyId, replacementCid]);
  await authPool.query("INSERT INTO creator_runs(id,conversation_id,message_id,revision,status,input,attempt) VALUES($1,$2,$1,2,'running',$3,$4)", [emptyId, replacementCid, JSON.stringify({ ...input, replacement: true, retainedCandidates: replacementResult.candidates }), emptyAttempt]);
  await completeCreatorRun(emptyId, emptyAttempt, [], []);
  const emptyResult = (await authPool.query("SELECT result FROM creator_runs WHERE id=$1", [emptyId])).rows[0].result;
  assert.equal(emptyResult.replacementAdded, 0);
  assert.deepEqual(emptyResult.candidates, replacementResult.candidates);
  const largeId = randomUUID(), largeAttempt = randomUUID();
  const developerProfiles = creators.filter(c => c.audience === "developers");
  const largeRetained = developerProfiles.slice(0, 20).map(c => ({ id: c.id, reason: c.evidence[0], evidenceIndexes: [0] }));
  const largeNew = { id: developerProfiles[20].id, reason: developerProfiles[20].evidence[0], evidenceIndexes: [0] };
  await authPool.query("INSERT INTO workspace_chat_messages(id,conversation_id,role,content,mode,status) VALUES($1,$2,'assistant','','creators','completed')", [largeId, replacementCid]);
  await authPool.query("INSERT INTO creator_runs(id,conversation_id,message_id,revision,status,input,attempt) VALUES($1,$2,$1,2,'running',$3,$4)", [largeId, replacementCid, JSON.stringify({ ...input, candidates: largeRetained, replacement: true, retainedCandidates: largeRetained }), largeAttempt]);
  await completeCreatorRun(largeId, largeAttempt, [largeNew.id], [largeNew]);
  assert.equal((await authPool.query("SELECT result FROM creator_runs WHERE id=$1", [largeId])).rows[0].result.candidates.length, 21);
  console.log(
    JSON.stringify({
      checks: [
        "attempt fencing",
        "duplicate progress",
        "stale snapshot preserved",
        "stale result cannot overwrite",
        "current result committed",
        "completion replay idempotent",
        "legacy shortlist anchored without fabricated agents",
        "legacy backfill preserves prior creators and is idempotent",
        "draft survives an unchanged reply and becomes stale when website context changes",
        "replacement snapshots seen and retained creators and merges a new result; empty search preserves them",
      ],
      paymentExecuted: false,
    }),
  );
} finally {
  await authPool.query("DELETE FROM auth_users WHERE id=$1", [user]);
  await authPool.end();
}
