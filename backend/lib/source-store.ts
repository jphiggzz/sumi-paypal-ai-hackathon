import { assertAdmissionWindow } from "./admission-window";
import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { z } from "zod";
import { transaction } from "./agent-store";
import {
  authorizeConnectionUse,
  acquireFixtureCredential,
} from "./connection-store";
import { CapabilityError } from "./capability-contracts";
import { sourceRefreshInput, sourceSearchInput } from "./knowledge-policy";
import { reserveConnectorBudget } from "./connector-budget";
import { readFixtureDocument } from "./connector-http";
import { driveAccessToken } from "./drive-auth";
import { readDriveDocument } from "./drive-provider";
export async function refreshSource(
  owner: string,
  input: z.infer<typeof sourceRefreshInput>,
  runId = "local-fixture",
) {
  const start = await transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      input.id,
    ]);
    const c = await authorizeConnectionUse(client, owner, input.connectionId, {
      expectedVersion: input.expectedVersion,
      requiredScopes: ["documents:read"],
      resourceId: input.resourceId,
    });
    if (!["fixture", "google"].includes(c.provider))
      throw new CapabilityError("PROVIDER_UNSUPPORTED", 400);
    if (c.provider !== "fixture" && input.fixtureRevision !== 1)
      throw new CapabilityError("FIXTURE_ONLY", 400);
    const prior = (
      await client.query("SELECT * FROM source_refreshes WHERE id=$1", [
        input.id,
      ])
    ).rows[0];
    if (prior) {
      if (
        prior.owner_id !== owner ||
        prior.connection_id !== c.id ||
        prior.resource_id !== input.resourceId ||
        prior.connection_version !== input.expectedVersion ||
        prior.fixture_revision !== input.fixtureRevision
      )
        throw new CapabilityError("REFRESH_CONFLICT", 409);
      if (prior.state === "queued" && prior.workflow_run_id === runId) {
        await client.query(
          "UPDATE source_refreshes SET state='running' WHERE id=$1",
          [input.id],
        );
        return { cached: false, sourceId: null, provider: c.provider };
      }
      if (prior.state === "completed")
        return {
          cached: true,
          sourceId: prior.source_id,
          provider: c.provider,
        };
      if (
        prior.workflow_run_id !== runId ||
        prior.attempts >= 3 ||
        (prior.state === "failed" &&
          !["PROVIDER_UNAVAILABLE", "PROVIDER_RATE_LIMITED"].includes(
            prior.error_code,
          ))
      )
        throw new CapabilityError(
          prior.error_code || "REFRESH_IN_PROGRESS",
          409,
        );
      await client.query(
        "UPDATE source_refreshes SET attempts=attempts+1,state='running',error_code=NULL WHERE id=$1",
        [input.id],
      );
      return { cached: false, sourceId: null, provider: c.provider };
    }
    throw new CapabilityError("SOURCE_NOT_ADMITTED", 409);
  });
  if (start.cached) return { sourceId: start.sourceId, replayed: true };
  try {
    let document: {
      title: string;
      content: string;
      providerVersion: string;
      url: string;
      fixture: boolean;
    };
    if (start.provider === "fixture") {
      const token = await transaction((client) =>
        acquireFixtureCredential(client, owner, input.connectionId, {
          expectedVersion: input.expectedVersion,
          requiredScopes: ["documents:read"],
          resourceId: input.resourceId,
        }),
      );
      const d = await readFixtureDocument(input.resourceId, token.token, {
        signal: AbortSignal.timeout(2500),
      });
      document = {
        title: d.title,
        content:
          input.fixtureRevision === 2
            ? d.text +
              "\nCorrection: the verification marker is DELTA88. This replaces DELTA77."
            : d.text + "\nThe verification marker is DELTA77.",
        providerVersion: d.version + ":" + input.fixtureRevision,
        url: d.sourceUrl,
        fixture: true,
      };
    } else
      document = await readDriveDocument(
        input.resourceId,
        await driveAccessToken(
          owner,
          input.connectionId,
          input.expectedVersion,
        ),
      );
    return await transaction(async (client) => {
      await authorizeConnectionUse(client, owner, input.connectionId, {
        expectedVersion: input.expectedVersion,
        requiredScopes: ["documents:read"],
        resourceId: input.resourceId,
      });
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [`sources:${owner}`],
      );
      const prior = (
        await client.query(
          "SELECT * FROM source_records WHERE connection_id=$1 AND resource_id=$2 FOR UPDATE",
          [input.connectionId, input.resourceId],
        )
      ).rows[0];
      const hash = createHash("sha256")
        .update(JSON.stringify(document))
        .digest("hex");
      if (prior) {
        const ordinal = (v: string) =>
          document.fixture ? v.split(":").at(-1)! : v;
        const old = ordinal(prior.provider_version),
          next = ordinal(document.providerVersion);
        if (
          /^\d+$/.test(old) &&
          /^\d+$/.test(next) &&
          BigInt(next) < BigInt(old)
        )
          throw new CapabilityError("SOURCE_STALE_READ", 409);
        if (
          prior.connection_version === input.expectedVersion &&
          prior.provider_version === document.providerVersion &&
          prior.content_hash !== hash
        )
          throw new CapabilityError("PROVIDER_VERSION_CONFLICT", 409);
      }
      const version = prior
        ? prior.content_hash === hash &&
          prior.connection_version === input.expectedVersion
          ? prior.version
          : prior.version + 1
        : 1;
      if (version > 30) throw new CapabilityError("SOURCE_VERSION_LIMIT", 429);
      if (
        !prior &&
        +(
          await client.query(
            "SELECT count(*) FROM source_records WHERE owner_id=$1",
            [owner],
          )
        ).rows[0].count >= 100
      )
        throw new CapabilityError("SOURCE_LIMIT", 429);
      const id = prior?.id ?? randomUUID();
      const row = (
        await client.query(
          `INSERT INTO source_records(id,owner_id,connection_id,connection_version,resource_id,version,title,url,content,content_hash,provider_version,fixture,fetched_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now(),now()+interval '5 minutes') ON CONFLICT(connection_id,resource_id) DO UPDATE SET connection_version=$4,version=$6,title=$7,url=$8,content=$9,content_hash=$10,provider_version=$11,fixture=$12,fetched_at=now(),expires_at=now()+interval '5 minutes' RETURNING *`,
          [
            id,
            owner,
            input.connectionId,
            input.expectedVersion,
            input.resourceId,
            version,
            document.title,
            document.url,
            document.content,
            hash,
            document.providerVersion,
            document.fixture,
          ],
        )
      ).rows[0];
      await client.query(
        "INSERT INTO source_versions VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
        [id, version, owner, JSON.stringify(row)],
      );
      await client.query(
        "UPDATE source_refreshes SET state='completed',source_id=$2 WHERE id=$1",
        [input.id, id],
      );
      return {
        sourceId: id,
        version,
        fixture: document.fixture,
        replayed: false,
      };
    });
  } catch (error) {
    const code =
      error instanceof CapabilityError ? error.code : "PROVIDER_UNAVAILABLE";
    await transaction((client) =>
      client.query(
        "UPDATE source_refreshes SET state='failed',error_code=$2,retry_after_ms=$4 WHERE id=$1 AND owner_id=$3",
        [
          input.id,
          code,
          owner,
          error instanceof CapabilityError
            ? (error.retryAfterMs ?? null)
            : null,
        ],
      ),
    );
    throw new CapabilityError(
      code,
      error instanceof CapabilityError ? error.status : 502,
      error instanceof CapabilityError ? error.retryAfterMs : undefined,
    );
  }
}
export async function assertSourceReferences(
  client: PoolClient,
  owner: string,
  refs: { id: string; version: number }[],
) {
  for (const ref of [...refs].sort((a, b) => a.id.localeCompare(b.id))) {
    const row = (
      await client.query(
        "SELECT connection_id,connection_version,resource_id,kind,deleted_at FROM source_records WHERE id=$1 AND owner_id=$2",
        [ref.id, owner],
      )
    ).rows[0];
    if (!row || row.deleted_at)
      throw new CapabilityError("SOURCE_REVOKED", 409);
    if (row.kind === "connector")
      await authorizeConnectionUse(client, owner, row.connection_id, {
        expectedVersion: row.connection_version,
        requiredScopes: ["documents:read"],
        resourceId: row.resource_id,
      });
    const current = (
      await client.query(
        "SELECT version,expires_at,deleted_at FROM source_records WHERE id=$1 AND owner_id=$2 FOR SHARE",
        [ref.id, owner],
      )
    ).rows[0];
    if (
      current.deleted_at ||
      current.version !== ref.version ||
      new Date(current.expires_at).getTime() <= Date.now()
    )
      throw new CapabilityError("SOURCE_CHANGED", 409);
  }
}
export async function searchSources(
  client: PoolClient,
  owner: string,
  input: z.infer<typeof sourceSearchInput>,
) {
  const candidates = (
    await client.query(
      `SELECT s.*,ts_rank_cd(to_tsvector('simple',s.content),plainto_tsquery('simple',$2)) AS rank FROM source_records s LEFT JOIN agent_connections c ON c.id=s.connection_id WHERE s.owner_id=$1 AND s.deleted_at IS NULL AND ((s.kind IN ('upload','public')) OR (s.kind='connector' AND c.owner_id=$1 AND c.status='connected' AND c.version=s.connection_version AND c.expires_at>now() AND s.resource_id=ANY(c.resource_ids) AND 'documents:read'=ANY(c.scopes))) AND s.expires_at>now() AND ($3::uuid IS NULL OR s.id=$3) AND to_tsvector('simple',s.content) @@ plainto_tsquery('simple',$2) ORDER BY rank DESC,s.id LIMIT $4`,
      [owner, input.query, input.sourceId ?? null, input.limit],
    )
  ).rows;
  await assertSourceReferences(
    client,
    owner,
    candidates.map((r) => ({ id: r.id, version: r.version })),
  );
  return {
    sources: candidates.map((r) => {
      const terms = input.query.toLowerCase().split(/\s+/).filter(Boolean);
      const lower = r.content.toLowerCase();
      const offsets = terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0);
      const index = offsets.length ? Math.min(...offsets) : 0;
      return {
        id: r.id,
        version: r.version,
        title: r.title,
        url: r.url,
        excerpt: r.content.slice(
          Math.max(0, index - 100),
          Math.max(0, index - 100) + 1800,
        ),
        contentHash: r.content_hash,
        providerVersion: r.provider_version,
        retrievedAt: new Date(r.fetched_at).toISOString(),
        citation: `[source:${r.id}@${r.version}]`,
        fixture: r.fixture,
        originKind: r.kind,
        untrusted: true,
      };
    }),
  };
}
export async function existingRefresh(
  client: PoolClient,
  owner: string,
  input: z.infer<typeof sourceRefreshInput>,
) {
  const row = (
    await client.query("SELECT * FROM source_refreshes WHERE id=$1", [input.id])
  ).rows[0];
  if (
    row &&
    (row.owner_id !== owner ||
      row.connection_id !== input.connectionId ||
      row.connection_version !== input.expectedVersion ||
      row.resource_id !== input.resourceId ||
      row.fixture_revision !== input.fixtureRevision)
  )
    throw new CapabilityError("REFRESH_CONFLICT", 409);
  return row;
}
export async function admitSourceRefresh(
  owner: string,
  input: z.infer<typeof sourceRefreshInput>,
  runId: string,
  deadline: number,
) {
  return transaction(async (client) => {
    await assertAdmissionWindow(client, deadline);
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      input.id,
    ]);
    const c = await authorizeConnectionUse(client, owner, input.connectionId, {
      expectedVersion: input.expectedVersion,
      requiredScopes: ["documents:read"],
      resourceId: input.resourceId,
    });
    if (
      !["fixture", "google"].includes(c.provider) ||
      (c.provider !== "fixture" && input.fixtureRevision !== 1)
    )
      throw new CapabilityError("PROVIDER_UNSUPPORTED", 400);
    const prior = await existingRefresh(client, owner, input);
    if (prior) return prior;
    await reserveConnectorBudget(client, owner, c.id);
    const row = (
      await client.query(
        "INSERT INTO source_refreshes(id,owner_id,connection_id,connection_version,resource_id,fixture_revision,state,workflow_run_id) VALUES($1,$2,$3,$4,$5,$6,'queued',$7) RETURNING *",
        [
          input.id,
          owner,
          c.id,
          c.version,
          input.resourceId,
          input.fixtureRevision,
          runId,
        ],
      )
    ).rows[0];
    await assertAdmissionWindow(client, deadline);
    return row;
  });
}
