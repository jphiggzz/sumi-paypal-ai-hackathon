import { z } from "zod";
import {
  CapabilityError,
  type ConnectionHandle,
  type ConnectionUse,
} from "./capability-contracts";

export const fixtureResourceIds = ["doc-alpha", "doc-beta"] as const;
const scopes = z.array(z.enum(["documents:read", "notes:write"])).max(2);
const resourceIds = z.array(z.string().regex(/^[A-Za-z0-9_-]{1,160}$/)).max(20);
const expiry = z.iso.datetime({ offset: true }).nullable();
export const connectionInput = z
  .object({
    id: z.uuid().optional(),
    provider: z.enum(["fixture", "google", "notion"]),
    scopes: scopes.optional(),
    resourceIds: resourceIds.optional(),
    expiresAt: expiry.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.provider !== "fixture" ||
      !value.resourceIds?.some(
        (r) =>
          !fixtureResourceIds.includes(
            r as (typeof fixtureResourceIds)[number],
          ),
      ),
    { message: "Unknown fixture resource." },
  )
  .refine(
    (value) =>
      value.provider === "fixture" || !value.scopes?.includes("notes:write"),
    { message: "Write grants are fixture-only." },
  );
export const connectionChange = z
  .object({
    expectedVersion: z.number().int().positive(),
    action: z.enum(["disconnect", "reconnect", "update"]),
    scopes: scopes.optional(),
    resourceIds: resourceIds.optional(),
    expiresAt: expiry.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.action === "disconnect" &&
      (value.scopes !== undefined ||
        value.resourceIds !== undefined ||
        value.expiresAt !== undefined)
    )
      context.addIssue({
        code: "custom",
        message: "Disconnect does not accept grants.",
        path: ["action"],
      });
  });
export type ConnectionInput = z.infer<typeof connectionInput>;
export type ConnectionChange = z.infer<typeof connectionChange>;

export function assertConnectionUse(
  connection: ConnectionHandle | undefined,
  ownerId: string,
  use: ConnectionUse,
  now = Date.now(),
): asserts connection is ConnectionHandle {
  if (!connection || connection.ownerId !== ownerId)
    throw new CapabilityError("connection_not_found", 404);
  if (
    use.expectedVersion !== undefined &&
    connection.version !== use.expectedVersion
  )
    throw new CapabilityError("connection_version_conflict");
  if (connection.status !== "connected")
    throw new CapabilityError(
      connection.status === "requires_authorization"
        ? "consent_required"
        : `connection_${connection.status}`,
    );
  if (connection.expiresAt !== null && Date.parse(connection.expiresAt) <= now)
    throw new CapabilityError("connection_expired");
  if (use.requiredScopes.some((scope) => !connection.scopes.includes(scope)))
    throw new CapabilityError("connection_scope_denied", 403);
  if (
    use.resourceId !== undefined &&
    !connection.resourceIds.includes(use.resourceId)
  )
    throw new CapabilityError("connection_resource_denied", 403);
}
export function connectionExpiry(
  value: string | null | undefined,
  now = Date.now(),
) {
  const result =
    value === undefined ? new Date(now + 60 * 60 * 1000).toISOString() : value;
  if (
    result === null ||
    !Number.isFinite(Date.parse(result)) ||
    Date.parse(result) <= now ||
    Date.parse(result) > now + 30 * 86400_000
  )
    throw new CapabilityError("invalid_connection_expiry", 400);
  return new Date(result).toISOString();
}
export function changedConnection(
  prior: ConnectionHandle,
  input: ConnectionChange,
  now = Date.now(),
): ConnectionHandle {
  if (prior.version !== input.expectedVersion)
    throw new CapabilityError("connection_version_conflict");
  if (input.action === "disconnect")
    return { ...prior, version: prior.version + 1, status: "disconnected" };
  if (
    prior.provider === "fixture" &&
    input.resourceIds?.some(
      (r) =>
        !fixtureResourceIds.includes(r as (typeof fixtureResourceIds)[number]),
    )
  )
    throw new CapabilityError("invalid_connection_change", 400);
  if (prior.provider !== "fixture") {
    if (
      prior.provider !== "google" ||
      prior.status !== "connected" ||
      input.action !== "update" ||
      input.scopes !== undefined ||
      input.expiresAt !== undefined
    )
      throw new CapabilityError("consent_required");
    return {
      ...prior,
      version: prior.version + 1,
      resourceIds: input.resourceIds ?? prior.resourceIds,
    };
  }
  if (
    input.action === "update" &&
    (prior.status !== "connected" ||
      (prior.expiresAt !== null && Date.parse(prior.expiresAt) <= now))
  )
    throw new CapabilityError("connection_reconnect_required");
  return {
    ...prior,
    version: prior.version + 1,
    status: "connected",
    scopes: input.scopes ?? prior.scopes,
    resourceIds: input.resourceIds ?? prior.resourceIds,
    expiresAt:
      input.action === "reconnect"
        ? connectionExpiry(input.expiresAt, now)
        : input.expiresAt === undefined
          ? prior.expiresAt
          : connectionExpiry(input.expiresAt, now),
  };
}
