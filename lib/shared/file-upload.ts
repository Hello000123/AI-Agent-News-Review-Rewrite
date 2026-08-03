export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_UPLOAD_MEGABYTES = 10;

export const SUPPORTED_UPLOADS = {
  ".pdf": {
    label: "PDF",
    mimeTypes: ["application/pdf"],
  },
  ".docx": {
    label: "Microsoft Word",
    mimeTypes: [
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ],
  },
  ".pptx": {
    label: "Microsoft PowerPoint",
    mimeTypes: [
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ],
  },
  ".xlsx": {
    label: "Microsoft Excel",
    mimeTypes: [
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ],
  },
  ".png": {
    label: "PNG image",
    mimeTypes: ["image/png"],
  },
  ".jpg": {
    label: "JPEG image",
    mimeTypes: ["image/jpeg"],
  },
  ".jpeg": {
    label: "JPEG image",
    mimeTypes: ["image/jpeg"],
  },
  ".webp": {
    label: "WebP image",
    mimeTypes: ["image/webp"],
  },
} as const;

export type SupportedUploadExtension = keyof typeof SUPPORTED_UPLOADS;
export type SupportedUploadMime =
  (typeof SUPPORTED_UPLOADS)[SupportedUploadExtension]["mimeTypes"][number];

export const FILE_UPLOAD_ACCEPT = Object.entries(SUPPORTED_UPLOADS)
  .flatMap(([extension, format]) => [extension, ...format.mimeTypes])
  .join(",");

export const SUPPORTED_UPLOAD_HELP =
  "PDF, DOCX, PPTX, XLSX, PNG, JPG, JPEG, or WebP; up to 10 MB per file.";

export interface UploadMetadata {
  name: string;
  type: string;
  size: number;
}

export interface UploadMetadataValidation {
  extension: SupportedUploadExtension;
  mimeType: SupportedUploadMime;
  formatLabel: string;
}

export function uploadExtension(fileName: string) {
  const normalized = fileName.normalize("NFC").trim().toLowerCase();
  const dot = normalized.lastIndexOf(".");
  return dot >= 0 ? normalized.slice(dot) : "";
}

export function validateUploadMetadata(
  file: UploadMetadata,
): UploadMetadataValidation | { error: string } {
  if (!file.name.trim()) {
    return { error: "Choose a file before continuing." };
  }
  if (file.size <= 0) {
    return { error: "The selected file is empty." };
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return {
      error: `The selected file is larger than the ${MAX_UPLOAD_MEGABYTES} MB limit.`,
    };
  }

  const extension = uploadExtension(file.name);
  if (!(extension in SUPPORTED_UPLOADS)) {
    return {
      error:
        "Unsupported file format. Choose a PDF, DOCX, PPTX, XLSX, PNG, JPG, JPEG, or WebP file.",
    };
  }

  const supportedExtension = extension as SupportedUploadExtension;
  const mimeType = file.type.trim().toLowerCase();
  const format = SUPPORTED_UPLOADS[supportedExtension];
  if (!(format.mimeTypes as readonly string[]).includes(mimeType)) {
    return {
      error:
        "The file type does not match its extension. Export the file again and retry.",
    };
  }

  return {
    extension: supportedExtension,
    mimeType: mimeType as SupportedUploadMime,
    formatLabel: format.label,
  };
}

export function sanitizeUploadFileName(fileName: string) {
  const normalized = fileName
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f]/gu, "")
    .replace(/[\\/:"*?<>|]/gu, "_")
    .replace(/\s+/gu, " ")
    .replace(/^\.+/gu, "")
    .trim()
    .slice(0, 180)
    .replace(/[.\s]+$/gu, "");
  return normalized || "uploaded-file";
}

export function isImageUploadMime(mimeType: string) {
  return ["image/png", "image/jpeg", "image/webp"].includes(
    mimeType.toLowerCase(),
  );
}
