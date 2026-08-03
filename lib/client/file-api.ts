import { AuthRequestError, csrfHeaders } from "@/lib/client/auth-api";

export interface ExtractedFileResponse {
  file: {
    name: string;
    type: string;
    mimeType: string;
    size: number;
    status: "ready";
  };
  content: string;
  truncated: boolean;
}

export async function requestFileExtraction(file: File) {
  const formData = new FormData();
  formData.set("file", file);
  const response = await fetch("/api/uploads/extract", {
    method: "POST",
    headers: {
      Accept: "application/json",
      ...csrfHeaders(),
    },
    body: formData,
    cache: "no-store",
  });

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new AuthRequestError(
      "INVALID_SERVER_RESPONSE",
      "The server returned an unreadable upload response.",
      undefined,
      response.status,
    );
  }
  if (!response.ok) {
    const errorBody = body as {
      error?: { code?: string; message?: string };
    };
    throw new AuthRequestError(
      errorBody.error?.code || "UPLOAD_FAILED",
      errorBody.error?.message || "The file could not be processed.",
      undefined,
      response.status,
    );
  }
  return body as ExtractedFileResponse;
}
