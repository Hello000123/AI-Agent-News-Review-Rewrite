import { requireApiSession } from "@/lib/server/auth/guards";
import { authErrorResponse } from "@/lib/server/auth/http";
import { AppError } from "@/lib/server/errors";
import { jsonResponse } from "@/lib/server/http";
import { extractUploadedFile } from "@/lib/server/uploads/file-processing";
import { MAX_UPLOAD_BYTES } from "@/lib/shared/file-upload";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_MULTIPART_BYTES = MAX_UPLOAD_BYTES + 128 * 1024;

function uploadedFile(formData: FormData) {
  const candidate = formData.get("file");
  if (!(candidate instanceof File)) {
    throw new AppError(
      "FILE_REQUIRED",
      "Choose a supported file before continuing.",
      400,
    );
  }
  return candidate;
}

export async function POST(request: Request) {
  try {
    await requireApiSession(request, ["client", "employee"], { csrf: true });
    const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.startsWith("multipart/form-data;")) {
      throw new AppError(
        "UNSUPPORTED_MEDIA_TYPE",
        "Upload the file using multipart form data.",
        415,
      );
    }
    const contentLength = Number(request.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_MULTIPART_BYTES) {
      throw new AppError(
        "FILE_TOO_LARGE",
        "The selected file is larger than the 10 MB limit.",
        413,
      );
    }

    let formData: FormData;
    try {
      formData = await request.formData();
    } catch (error) {
      throw new AppError(
        "INVALID_UPLOAD",
        "The uploaded file could not be read.",
        400,
        { cause: error },
      );
    }
    const extracted = await extractUploadedFile(uploadedFile(formData));
    return jsonResponse({
      file: {
        name: extracted.safeName,
        type: extracted.formatLabel,
        mimeType: extracted.mimeType,
        size: extracted.size,
        status: "ready",
      },
      content: extracted.content,
      truncated: extracted.truncated,
    });
  } catch (error) {
    return authErrorResponse(error, {
      operation: "upload.extract",
      request,
    });
  }
}
