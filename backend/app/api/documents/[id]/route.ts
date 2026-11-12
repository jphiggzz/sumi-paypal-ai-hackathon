import { z } from "zod";
import {
  admittedUser,
  canStartTask,
  sameOrigin,
  noStore,
} from "../../../../lib/agent-api";
import { apiFailure, boundedJson } from "../../../../lib/foundation-api";
import { transaction } from "../../../../lib/agent-store";
import { assertSourceReferences } from "../../../../lib/source-store";
import { removeDocument } from "../../../../lib/document-policy";
import { removeOwnedDocument } from "../../../../lib/document-store";
import { CapabilityError } from "../../../../lib/capability-contracts";
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const a = await admittedUser(request);
  if (a.error) return a.error;
  try {
    const { id } = await params;
    if (!z.uuid().safeParse(id).success)
      return new Response(null, { status: 404 });
    return Response.json(
      await transaction(async (c) => {
        const r = (
          await c.query(
            "SELECT id,version,kind,title,url,content_hash,fetched_at,expires_at,deleted_at FROM source_records WHERE id=$1 AND owner_id=$2 AND kind IN ('upload','public')",
            [id, a.user.id],
          )
        ).rows[0];
        if (!r) throw new CapabilityError("DOCUMENT_NOT_FOUND", 404);
        return { document: r };
      }),
      { headers: noStore },
    );
  } catch (e) {
    return apiFailure(e);
  }
}
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!sameOrigin(request)) return new Response(null, { status: 403 });
  const a = await admittedUser(request);
  if (a.error) return a.error;
  if (!canStartTask(request, a.user))
    return new Response(null, { status: 403 });
  try {
    const { id } = await params;
    if (!z.uuid().safeParse(id).success)
      return new Response(null, { status: 404 });
    const p = removeDocument.safeParse(await boundedJson(request));
    if (!p.success) return new Response(null, { status: 400 });
    return Response.json(await removeOwnedDocument(a.user.id, id, p.data), {
      headers: noStore,
    });
  } catch (e) {
    return apiFailure(e);
  }
}
