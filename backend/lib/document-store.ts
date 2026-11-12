import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import type { z } from "zod";
import { transaction } from "./agent-store";
import { CapabilityError } from "./capability-contracts";
import { uploadInput, publicInput, removeDocument } from "./document-policy";
import { inputHash, resultEvent, workQuota } from "./result-store";
import { reserveConnectorBudget } from "./connector-budget";
import { assertAdmissionWindow } from "./admission-window";
import { publicDocumentUrl } from "./public-document";
export async function documentRequest(
  c: PoolClient,
  owner: string,
  id: string,
  digest: string,
) {
  const r = (await c.query("SELECT * FROM document_requests WHERE id=$1", [id]))
    .rows[0];
  if (r && (r.owner_id !== owner || r.input_digest !== digest))
    throw new CapabilityError("DOCUMENT_REQUEST_CONFLICT", 409);
  return r;
}
async function ownedMutable(
  c: PoolClient,
  owner: string,
  id: string,
  version: number,
  kind: string,
) {
  const r = (
    await c.query("SELECT * FROM source_records WHERE id=$1 FOR UPDATE", [id])
  ).rows[0];
  if (r && (r.owner_id !== owner || r.kind !== kind))
    throw new CapabilityError("DOCUMENT_NOT_FOUND", 404);
  if (r?.deleted_at || (!r && version !== 0) || (r && r.version !== version))
    throw new CapabilityError("DOCUMENT_VERSION_CONFLICT", 409);
  return r;
}
export async function putOwnedSource(
  c: PoolClient,
  owner: string,
  input: {
    sourceId: string;
    expectedVersion: number;
    kind: "upload" | "public";
    title: string;
    content: string;
    url: string;
  },
) {
  const prior = await ownedMutable(
    c,
    owner,
    input.sourceId,
    input.expectedVersion,
    input.kind,
  );
  if (
    !prior &&
    +(
      await c.query("SELECT count(*) FROM source_records WHERE owner_id=$1", [
        owner,
      ])
    ).rows[0].count >= 100
  )
    throw new CapabilityError("SOURCE_LIMIT", 429);
  const hash = createHash("sha256")
    .update(
      JSON.stringify({
        title: input.title,
        content: input.content,
        url: input.url,
      }),
    )
    .digest("hex");
  const version = prior
    ? prior.content_hash === hash
      ? prior.version
      : prior.version + 1
    : 1;
  if (version > 30) throw new CapabilityError("SOURCE_VERSION_LIMIT", 429);
  const row = (
    await c.query(
      `INSERT INTO source_records(id,owner_id,connection_id,connection_version,resource_id,version,title,url,content,content_hash,provider_version,fixture,fetched_at,expires_at,kind) VALUES($1,$2,NULL,0,($1::uuid)::text,$3,$4,$5,$6,$7,$7,false,now(),CASE WHEN $8='upload' THEN '2100-01-01'::timestamptz ELSE now()+interval '5 minutes' END,$8) ON CONFLICT(id) DO UPDATE SET version=$3,title=$4,url=$5,content=$6,content_hash=$7,provider_version=$7,fetched_at=now(),expires_at=EXCLUDED.expires_at RETURNING *`,
      [
        input.sourceId,
        owner,
        version,
        input.title,
        input.url,
        input.content,
        hash,
        input.kind,
      ],
    )
  ).rows[0];
  await c.query(
    "INSERT INTO source_versions VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
    [row.id, version, owner, JSON.stringify(row)],
  );
  return { sourceId: row.id, version, kind: input.kind, contentHash: hash };
}
export async function storeUpload(
  owner: string,
  raw: z.infer<typeof uploadInput>,
) {
  const input = uploadInput.parse({
    ...raw,
    content: raw.content.replace(/\r\n/g, "\n"),
  });
  const hash = inputHash(input);
  return transaction(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "sources:" + owner,
    ]);
    const prior = await documentRequest(c, owner, input.requestId, hash);
    if (prior) return { ...prior.result, replayed: true };
    await workQuota(c, owner, "documents", 50);
    const result = await putOwnedSource(c, owner, {
      sourceId: input.sourceId,
      expectedVersion: input.expectedVersion,
      kind: "upload",
      title: input.filename,
      content: input.content,
      url: "upload:" + input.sourceId,
    });
    await c.query(
      "INSERT INTO document_requests(id,owner_id,input_digest,source_id,kind,state,request,result) VALUES($1,$2,$3,$4,'upload','completed',$5,$6)",
      [
        input.requestId,
        owner,
        hash,
        input.sourceId,
        JSON.stringify({ ...input, content: undefined }),
        JSON.stringify(result),
      ],
    );
    await resultEvent(
      c,
      owner,
      "document:" + input.requestId,
      "document.updated",
      result,
    );
    return { ...result, replayed: false };
  });
}
export async function removeOwnedDocument(
  owner: string,
  id: string,
  input: z.infer<typeof removeDocument>,
) {
  return transaction(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "sources:" + owner,
    ]);
    const hash = inputHash({ id, ...input, action: "delete" }),
      prior = await documentRequest(c, owner, input.requestId, hash);
    if (prior) return prior.result;
    const r = (
      await c.query(
        "SELECT * FROM source_records WHERE id=$1 AND owner_id=$2 AND kind IN ('upload','public') FOR UPDATE",
        [id, owner],
      )
    ).rows[0];
    if (!r) throw new CapabilityError("DOCUMENT_NOT_FOUND", 404);
    if (r.version !== input.expectedVersion || r.deleted_at)
      throw new CapabilityError("DOCUMENT_VERSION_CONFLICT", 409);
    await workQuota(c, owner, "documents", 50);
    const row = (
      await c.query(
        "UPDATE source_records SET version=version+1,deleted_at=now() WHERE id=$1 RETURNING *",
        [id],
      )
    ).rows[0];
    await c.query("INSERT INTO source_versions VALUES($1,$2,$3,$4)", [
      id,
      row.version,
      owner,
      JSON.stringify({
        ...row,
        content: "[tombstone; prior historical versions retained]",
      }),
    ]);
    const result = { sourceId: id, version: row.version, deleted: true };
    await c.query(
      "INSERT INTO document_requests(id,owner_id,input_digest,source_id,kind,state,request,result) VALUES($1,$2,$3,$4,'delete','completed',$5,$6)",
      [
        input.requestId,
        owner,
        hash,
        id,
        JSON.stringify(input),
        JSON.stringify(result),
      ],
    );
    await resultEvent(
      c,
      owner,
      "document:" + input.requestId,
      "document.deleted",
      result,
    );
    return result;
  });
}
export async function admitPublicDocument(
  owner: string,
  input: z.infer<typeof publicInput>,
  runId: string,
  deadline: number,
) {
  publicDocumentUrl(input.url);
  return transaction(async (c) => {
    await assertAdmissionWindow(c, deadline);
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "sources:" + owner,
    ]);
    const hash = inputHash(input),
      prior = await documentRequest(c, owner, input.requestId, hash);
    if (prior) return prior;
    await ownedMutable(
      c,
      owner,
      input.sourceId,
      input.expectedVersion,
      "public",
    );
    await workQuota(c, owner, "documents", 50);
    await reserveConnectorBudget(c, owner, "public:" + input.sourceId);
    const row = (
      await c.query(
        "INSERT INTO document_requests(id,owner_id,input_digest,source_id,kind,state,request,workflow_run_id) VALUES($1,$2,$3,$4,'public','queued',$5,$6) RETURNING *",
        [
          input.requestId,
          owner,
          hash,
          input.sourceId,
          JSON.stringify(input),
          runId,
        ],
      )
    ).rows[0];
    await assertAdmissionWindow(c, deadline);
    return row;
  });
}
