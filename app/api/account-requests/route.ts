import { accountRequestInputSchema } from "@/lib/shared/auth-contracts";
import { submitAccountRequest } from "@/lib/server/auth/account-service";
import { getPublicAppUrlForRequest } from "@/lib/server/auth/config";
import { getDatabase } from "@/lib/server/auth/database";
import { authErrorResponse, validateSameOrigin } from "@/lib/server/auth/http";
import { AppError } from "@/lib/server/errors";
import { jsonResponse, readJsonRequest } from "@/lib/server/http";
import { MAX_UPLOAD_BYTES } from "@/lib/shared/file-upload";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ACCOUNT_REQUEST_FIELDS = [
  "fullName",
  "email",
  "phone",
  "company",
  "department",
  "jobTitle",
  "adminMessage",
] as const;

async function parseAccountRequest(request: Request) {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("multipart/form-data;")) {
    return {
      input: accountRequestInputSchema.parse(await readJsonRequest(request)),
      attachment: undefined,
    };
  }

  const contentLength = Number(request.headers.get("content-length"));
  if (
    Number.isFinite(contentLength) &&
    contentLength > MAX_UPLOAD_BYTES + 256 * 1024
  ) {
    throw new AppError(
      "FILE_TOO_LARGE",
      "The supporting document is larger than the 10 MB limit.",
      413,
    );
  }
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch (error) {
    throw new AppError(
      "INVALID_UPLOAD",
      "The account request upload could not be read.",
      400,
      { cause: error },
    );
  }
  const rawInput = Object.fromEntries(
    ACCOUNT_REQUEST_FIELDS.map((field) => {
      const value = formData.get(field);
      return [field, typeof value === "string" ? value : ""];
    }),
  );
  const candidate = formData.get("attachment");
  const attachment =
    candidate instanceof File && candidate.name.trim() ? candidate : undefined;
  return {
    input: accountRequestInputSchema.parse(rawInput),
    attachment,
  };
}

export async function POST(request: Request) {
  try {
    validateSameOrigin(request);
    const { input, attachment } = await parseAccountRequest(request);
    const result = await submitAccountRequest(
      getDatabase(),
      input,
      getPublicAppUrlForRequest(request),
      attachment,
    );
    return jsonResponse(
      {
        requestId: result.request.id,
        status: result.request.status,
        message:
          "Your account request has been submitted and is awaiting employee approval.",
        notificationStatus: result.delivery.status,
      },
      201,
    );
  } catch (error) {
    return authErrorResponse(error, { operation: "account-request.create", request });
  }
}
