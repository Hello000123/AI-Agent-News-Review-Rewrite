import { getDatabase } from "@/lib/server/auth/database";
import { requireApiSession } from "@/lib/server/auth/guards";
import { authErrorResponse } from "@/lib/server/auth/http";
import { getAccountRequestAttachmentByRequestId } from "@/lib/server/auth/repository";
import { AppError } from "@/lib/server/errors";
import { getAccountDocumentBucket } from "@/lib/server/uploads/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

function encodedFileName(fileName: string) {
  return encodeURIComponent(fileName)
    .replace(/'/gu, "%27")
    .replace(/\(/gu, "%28")
    .replace(/\)/gu, "%29")
    .replace(/\*/gu, "%2A");
}

export async function GET(request: Request, context: RouteContext) {
  try {
    await requireApiSession(request, ["employee"]);
    const { id } = await context.params;
    const attachment = await getAccountRequestAttachmentByRequestId(
      getDatabase(),
      id,
    );
    if (!attachment) {
      throw new AppError(
        "ATTACHMENT_NOT_FOUND",
        "No supporting document is attached to this account request.",
        404,
      );
    }
    const object = await getAccountDocumentBucket().get(attachment.storageKey);
    if (!object) {
      throw new AppError(
        "ATTACHMENT_NOT_FOUND",
        "The supporting document is no longer available.",
        404,
      );
    }

    const mode = new URL(request.url).searchParams.get("mode");
    const disposition = mode === "view" ? "inline" : "attachment";
    return new Response(object.body as unknown as BodyInit, {
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Disposition":
          `${disposition}; filename*=UTF-8''${encodedFileName(attachment.fileName)}`,
        "Content-Length": String(attachment.size),
        "Content-Security-Policy": "sandbox; default-src 'none'",
        "Content-Type": attachment.mimeType,
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return authErrorResponse(error, {
      operation: "employee.account-request.attachment",
      request,
    });
  }
}
