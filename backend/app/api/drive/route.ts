import { z } from "zod";
import {
  admittedUser,
  sameOrigin,
  noStore,
  canStartTask,
} from "../../../lib/agent-api";
import { beginDriveOAuth, driveAccessToken } from "../../../lib/drive-auth";
import { readDriveDocument } from "../../../lib/drive-provider";
import { reserveConnectorBudget } from "../../../lib/connector-budget";
import { transaction } from "../../../lib/agent-store";
import {
  authorizeConnectionUse,
  changeConnection,
} from "../../../lib/connection-store";
import { apiFailure, boundedJson } from "../../../lib/foundation-api";
const input = z
  .object({
    action: z.enum(["authorize", "picker", "select"]),
    connectionId: z.uuid(),
    expectedVersion: z.number().int().positive(),
    resourceId: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,160}$/)
      .optional(),
  })
  .strict();
export async function POST(request: Request) {
  if (!sameOrigin(request)) return new Response(null, { status: 403 });
  const a = await admittedUser(request);
  if (a.error) return a.error;
  if (!canStartTask(request, a.user))
    return new Response(null, { status: 403 });
  try {
    const p = input.safeParse(await boundedJson(request));
    if (!p.success) return new Response(null, { status: 400 });
    const v = p.data;
    if (v.action === "authorize")
      return Response.json(
        await beginDriveOAuth(a.user.id, v.connectionId, v.expectedVersion),
        { headers: noStore },
      );
    const c = await transaction((client) =>
      authorizeConnectionUse(client, a.user.id, v.connectionId, {
        expectedVersion: v.expectedVersion,
        requiredScopes: ["documents:read"],
      }),
    );
    if (c.provider !== "google") return new Response(null, { status: 400 });
    if (v.action === "picker") {
      if (!process.env.GOOGLE_PICKER_API_KEY)
        return Response.json(
          { error: "PICKER_SETUP_REQUIRED" },
          { status: 503, headers: noStore },
        );
      return Response.json(
        {
          accessToken: await driveAccessToken(a.user.id, c.id, c.version),
          apiKey: process.env.GOOGLE_PICKER_API_KEY,
          appId: process.env.GOOGLE_CLIENT_ID?.split("-")[0],
        },
        { headers: noStore },
      );
    }
    if (!v.resourceId) return new Response(null, { status: 400 });
    await transaction((client) =>
      reserveConnectorBudget(client, a.user.id, c.id, 'selection'),
    );
    await readDriveDocument(
      v.resourceId,
      await driveAccessToken(a.user.id, c.id, c.version),
    );
    const result = await changeConnection(a.user.id, c.id, {
      action: "update",
      expectedVersion: c.version,
      resourceIds: [...new Set([...c.resourceIds, v.resourceId])],
    });
    return Response.json(result, { status: result.status, headers: noStore });
  } catch (e) {
    return apiFailure(e);
  }
}
