import {
  admittedUser,
  canStartTask,
  sameOrigin,
  noStore,
} from "../../../lib/agent-api";
import { apiFailure, boundedBytes } from "../../../lib/foundation-api";
import { uploadInput } from "../../../lib/document-policy";
import { storeUpload } from "../../../lib/document-store";
import { CapabilityError } from "../../../lib/capability-contracts";
function decodeUpload(bytes: ArrayBuffer) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new CapabilityError("UPLOAD_ENCODING_INVALID", 422);
  }
}
export async function POST(request: Request) {
  if (!sameOrigin(request)) return new Response(null, { status: 403 });
  const a = await admittedUser(request);
  if (a.error) return a.error;
  if (!canStartTask(request, a.user))
    return new Response(null, { status: 403 });
  try {
    const bytes = await boundedBytes(request, 40000);
    let value: unknown;
    const type = request.headers.get("content-type") ?? "";
    if (type.startsWith("multipart/form-data")) {
      const form = await new Request(request.url, {
        method: "POST",
        headers: { "Content-Type": type },
        body: bytes,
      }).formData();
      if (
        [...form.keys()].some(
          (k) =>
            !["requestId", "sourceId", "expectedVersion", "file"].includes(k),
        ) ||
        form.getAll("file").length !== 1
      )
        throw new CapabilityError("INVALID_UPLOAD", 400);
      const file = form.get("file");
      if (
        !(file instanceof File) ||
        file.size > 32768 ||
        ![
          "text/plain",
          "text/markdown",
          "application/octet-stream",
          "",
        ].includes(file.type)
      )
        throw new CapabilityError("UPLOAD_TYPE_OR_SIZE_DENIED", 415);
      value = {
        requestId: form.get("requestId"),
        sourceId: form.get("sourceId"),
        expectedVersion: Number(form.get("expectedVersion")),
        filename: file.name,
        content: decodeUpload(await file.arrayBuffer()),
      };
    } else if (type.startsWith("application/json"))
      value = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
    else throw new CapabilityError("UPLOAD_TYPE_DENIED", 415);
    const p = uploadInput.safeParse(value);
    if (!p.success) throw new CapabilityError("INVALID_UPLOAD", 400);
    return Response.json(await storeUpload(a.user.id, p.data), {
      status: 201,
      headers: noStore,
    });
  } catch (e) {
    return apiFailure(e);
  }
}
