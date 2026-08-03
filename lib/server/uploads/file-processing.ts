import { unzipSync } from "fflate";
import { extractText, getDocumentProxy } from "unpdf";

import { analyzeUploadedImage } from "@/lib/server/uploads/image-analysis";
import { AppError } from "@/lib/server/errors";
import {
  isImageUploadMime,
  sanitizeUploadFileName,
  validateUploadMetadata,
  type SupportedUploadExtension,
  type SupportedUploadMime,
} from "@/lib/shared/file-upload";
import { MAX_DRAFT_CHARS } from "@/lib/shared/contracts";

const OFFICE_MAX_ENTRIES = 5_000;
const OFFICE_MAX_EXPANDED_BYTES = 50 * 1024 * 1024;
const OFFICE_MAX_SINGLE_ENTRY_BYTES = 16 * 1024 * 1024;
const PDF_MAX_PAGES = 250;
const EXTRACTION_TIMEOUT_MS = 30_000;
const XML_DECODER = new TextDecoder("utf-8", { fatal: true });

export interface ValidatedUpload {
  bytes: Uint8Array;
  extension: SupportedUploadExtension;
  mimeType: SupportedUploadMime;
  formatLabel: string;
  safeName: string;
  size: number;
}

export interface ExtractedUpload extends ValidatedUpload {
  content: string;
  truncated: boolean;
}

function uploadError(
  code: string,
  message: string,
  status = 400,
  cause?: unknown,
) {
  return new AppError(code, message, status, cause ? { cause } : undefined);
}

function bytesStartWith(bytes: Uint8Array, expected: readonly number[]) {
  return expected.every((value, index) => bytes[index] === value);
}

function ascii(bytes: Uint8Array, start: number, length: number) {
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

function isOleCompoundFile(bytes: Uint8Array) {
  return bytesStartWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
}

function assertPdfSignature(bytes: Uint8Array) {
  if (ascii(bytes, 0, 5) !== "%PDF-") {
    throw uploadError(
      "FILE_TYPE_MISMATCH",
      "The file contents do not match the selected PDF format.",
    );
  }
  const sample = new TextDecoder("latin1").decode(bytes);
  if (/\/Encrypt\b/u.test(sample)) {
    throw uploadError(
      "FILE_PASSWORD_PROTECTED",
      "Password-protected or encrypted files cannot be processed.",
    );
  }
  if (!/%%EOF[\s\u0000]*$/u.test(sample.slice(-2_048))) {
    throw uploadError(
      "FILE_CORRUPTED",
      "The PDF appears to be corrupted or incomplete.",
    );
  }
}

function assertPngSignature(bytes: Uint8Array) {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (
    bytes.length < 33 ||
    !bytesStartWith(bytes, signature) ||
    ascii(bytes, 12, 4) !== "IHDR" ||
    !ascii(bytes, Math.max(0, bytes.length - 12), 12).includes("IEND")
  ) {
    throw uploadError("FILE_CORRUPTED", "The PNG image appears to be corrupted.");
  }
}

function assertJpegSignature(bytes: Uint8Array) {
  if (
    bytes.length < 12 ||
    !bytesStartWith(bytes, [0xff, 0xd8, 0xff]) ||
    bytes.at(-2) !== 0xff ||
    bytes.at(-1) !== 0xd9
  ) {
    throw uploadError("FILE_CORRUPTED", "The JPEG image appears to be corrupted.");
  }
}

function assertWebpSignature(bytes: Uint8Array) {
  if (
    bytes.length < 20 ||
    ascii(bytes, 0, 4) !== "RIFF" ||
    ascii(bytes, 8, 4) !== "WEBP" ||
    !["VP8 ", "VP8L", "VP8X"].includes(ascii(bytes, 12, 4))
  ) {
    throw uploadError("FILE_CORRUPTED", "The WebP image appears to be corrupted.");
  }
  const declaredLength =
    bytes[4] |
    (bytes[5] << 8) |
    (bytes[6] << 16) |
    (bytes[7] << 24);
  if ((declaredLength >>> 0) + 8 !== bytes.length) {
    throw uploadError("FILE_CORRUPTED", "The WebP image appears to be incomplete.");
  }
}

interface ZipEntryMetadata {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  encrypted: boolean;
}

function findEndOfCentralDirectory(bytes: Uint8Array) {
  const minimum = Math.max(0, bytes.length - 65_557);
  for (let index = bytes.length - 22; index >= minimum; index -= 1) {
    if (
      bytes[index] === 0x50 &&
      bytes[index + 1] === 0x4b &&
      bytes[index + 2] === 0x05 &&
      bytes[index + 3] === 0x06
    ) {
      return index;
    }
  }
  return -1;
}

function readZipEntries(bytes: Uint8Array) {
  if (!bytesStartWith(bytes, [0x50, 0x4b])) {
    if (isOleCompoundFile(bytes)) {
      throw uploadError(
        "FILE_PASSWORD_PROTECTED",
        "Password-protected or encrypted Microsoft Office files cannot be processed.",
      );
    }
    throw uploadError(
      "FILE_TYPE_MISMATCH",
      "The file contents do not match the selected Microsoft Office format.",
    );
  }

  const end = findEndOfCentralDirectory(bytes);
  if (end < 0) {
    throw uploadError(
      "FILE_CORRUPTED",
      "The Microsoft Office file appears to be corrupted or incomplete.",
    );
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entryCount = view.getUint16(end + 10, true);
  const centralOffset = view.getUint32(end + 16, true);
  if (entryCount > OFFICE_MAX_ENTRIES) {
    throw uploadError(
      "FILE_TOO_COMPLEX",
      "The Microsoft Office file contains too many internal items to process safely.",
    );
  }

  const entries: ZipEntryMetadata[] = [];
  let offset = centralOffset;
  let expandedBytes = 0;
  for (let entryIndex = 0; entryIndex < entryCount; entryIndex += 1) {
    if (
      offset + 46 > bytes.length ||
      view.getUint32(offset, true) !== 0x02014b50
    ) {
      throw uploadError(
        "FILE_CORRUPTED",
        "The Microsoft Office file contains a damaged archive directory.",
      );
    }
    const flags = view.getUint16(offset + 8, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    if (
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      offset + 46 + nameLength + extraLength + commentLength > bytes.length
    ) {
      throw uploadError(
        "FILE_TOO_COMPLEX",
        "The Microsoft Office file uses an unsupported archive structure.",
      );
    }
    const name = new TextDecoder().decode(
      bytes.subarray(offset + 46, offset + 46 + nameLength),
    );
    if (
      name.startsWith("/") ||
      name.includes("\\") ||
      name.split("/").some((segment) => segment === "..")
    ) {
      throw uploadError(
        "FILE_UNSAFE",
        "The Microsoft Office file contains unsafe internal paths.",
      );
    }
    expandedBytes += uncompressedSize;
    if (
      uncompressedSize > OFFICE_MAX_SINGLE_ENTRY_BYTES ||
      expandedBytes > OFFICE_MAX_EXPANDED_BYTES
    ) {
      throw uploadError(
        "FILE_TOO_COMPLEX",
        "The Microsoft Office file expands beyond the safe processing limit.",
      );
    }
    entries.push({
      name,
      compressedSize,
      uncompressedSize,
      encrypted: Boolean(flags & 0x1),
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }

  if (entries.some((entry) => entry.encrypted)) {
    throw uploadError(
      "FILE_PASSWORD_PROTECTED",
      "Password-protected or encrypted Microsoft Office files cannot be processed.",
    );
  }
  if (
    entries.some((entry) =>
      /(?:^|\/)(?:vbaProject\.bin|macrosheets\/)/iu.test(entry.name),
    )
  ) {
    throw uploadError(
      "FILE_UNSAFE",
      "Files containing macros are not supported.",
    );
  }
  return entries;
}

function unzipOffice(bytes: Uint8Array, entries: ZipEntryMetadata[]) {
  const allowed = new Set(entries.map((entry) => entry.name));
  try {
    return unzipSync(bytes, {
      filter(file) {
        return (
          allowed.has(file.name) &&
          file.originalSize <= OFFICE_MAX_SINGLE_ENTRY_BYTES
        );
      },
    });
  } catch (error) {
    throw uploadError(
      "FILE_CORRUPTED",
      "The Microsoft Office file could not be opened. It may be corrupted or password-protected.",
      400,
      error,
    );
  }
}

function xmlFile(
  archive: Record<string, Uint8Array>,
  path: string,
  required = true,
) {
  const bytes = archive[path];
  if (!bytes) {
    if (!required) return "";
    throw uploadError(
      "FILE_CORRUPTED",
      "The Microsoft Office file is missing required document data.",
    );
  }
  try {
    return XML_DECODER.decode(bytes);
  } catch (error) {
    throw uploadError(
      "FILE_CORRUPTED",
      "The Microsoft Office file contains unreadable document data.",
      400,
      error,
    );
  }
}

function decodeXml(value: string) {
  return value
    .replace(/&#x([0-9a-f]+);/giu, (_, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    )
    .replace(/&#(\d+);/gu, (_, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 10)),
    )
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&amp;/gu, "&");
}

function attributeValue(attributes: string, name: string) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = attributes.match(
    new RegExp(`(?:^|\\s)${escapedName}=(?:"([^"]*)"|'([^']*)')`, "iu"),
  );
  return match ? decodeXml(match[1] ?? match[2] ?? "") : "";
}

function textNodes(xml: string, tag = "t") {
  const pattern = new RegExp(
    `<(?:[A-Za-z0-9_-]+:)?${tag}\\b[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z0-9_-]+:)?${tag}>`,
    "giu",
  );
  return [...xml.matchAll(pattern)].map((match) =>
    decodeXml(match[1].replace(/<[^>]*>/gu, "")),
  );
}

function paragraphText(xml: string) {
  return xml
    .replace(
      /<(?:[A-Za-z0-9_-]+:)?t\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_-]+:)?t>/giu,
      (_, value: string) => decodeXml(value.replace(/<[^>]*>/gu, "")),
    )
    .replace(/<(?:[A-Za-z0-9_-]+:)?tab\b[^>]*\/?>/giu, "\t")
    .replace(/<(?:[A-Za-z0-9_-]+:)?br\b[^>]*\/?>/giu, "\n")
    .replace(/<[^>]*>/gu, "");
}

function sanitizeExtractedContent(content: string) {
  const normalized = content
    .normalize("NFC")
    .replace(/\r\n?/gu, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{4,}/gu, "\n\n\n")
    .trim();
  const truncated = normalized.length > MAX_DRAFT_CHARS;
  return {
    content: normalized.slice(0, MAX_DRAFT_CHARS),
    truncated,
  };
}

function extractDocx(archive: Record<string, Uint8Array>) {
  const documentXml = xmlFile(archive, "word/document.xml");
  const paragraphs = [
    ...documentXml.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/giu),
  ]
    .map((match) => paragraphText(match[1]).trimEnd())
    .filter((value) => value.trim());
  return paragraphs.join("\n");
}

function relationshipMap(xml: string) {
  const relationships = new Map<string, string>();
  for (const match of xml.matchAll(/<Relationship\b([^>]*)\/?>/giu)) {
    const id = attributeValue(match[1], "Id");
    const target = attributeValue(match[1], "Target");
    const targetMode = attributeValue(match[1], "TargetMode");
    if (id && target && targetMode.toLowerCase() !== "external") {
      relationships.set(id, target);
    }
  }
  return relationships;
}

function officeTarget(root: "ppt" | "xl", target: string) {
  const segments: string[] = [root];
  for (const segment of target.replace(/\\/gu, "/").split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (segments.length <= 1) {
        throw uploadError("FILE_UNSAFE", "The document contains an unsafe internal path.");
      }
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join("/");
}

function extractPptx(archive: Record<string, Uint8Array>) {
  const presentation = xmlFile(archive, "ppt/presentation.xml");
  const rels = relationshipMap(
    xmlFile(archive, "ppt/_rels/presentation.xml.rels"),
  );
  const slideIds = [
    ...presentation.matchAll(/<p:sldId\b([^>]*)\/?>/giu),
  ].map((match) => attributeValue(match[1], "r:id"));
  if (!slideIds.length) return "";

  return slideIds
    .map((relationshipId, index) => {
      const target = rels.get(relationshipId);
      if (!target) {
        throw uploadError(
          "FILE_CORRUPTED",
          "The PowerPoint slide order could not be read.",
        );
      }
      const slideXml = xmlFile(archive, officeTarget("ppt", target));
      const paragraphs = [
        ...slideXml.matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/giu),
      ]
        .map((match) => paragraphText(match[1]).trim())
        .filter(Boolean);
      return [`[Slide ${index + 1}]`, ...paragraphs].join("\n");
    })
    .join("\n\n");
}

function extractSharedStrings(archive: Record<string, Uint8Array>) {
  const xml = xmlFile(archive, "xl/sharedStrings.xml", false);
  if (!xml) return [];
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/giu)].map((match) =>
    textNodes(match[1]).join(""),
  );
}

function cellText(
  attributes: string,
  body: string,
  sharedStrings: string[],
) {
  const type = attributeValue(attributes, "t");
  if (type === "inlineStr") return textNodes(body).join("");
  const rawValue = body.match(/<v\b[^>]*>([\s\S]*?)<\/v>/iu)?.[1] ?? "";
  const decodedValue = decodeXml(rawValue.replace(/<[^>]*>/gu, ""));
  if (type === "s") {
    const index = Number.parseInt(decodedValue, 10);
    return Number.isInteger(index) ? sharedStrings[index] ?? "" : "";
  }
  if (type === "b") return decodedValue === "1" ? "TRUE" : "FALSE";
  if (type === "e") return `[Error: ${decodedValue}]`;
  const formula = body.match(/<f\b[^>]*>([\s\S]*?)<\/f>/iu)?.[1];
  if (formula) {
    const decodedFormula = decodeXml(formula.replace(/<[^>]*>/gu, ""));
    return decodedValue
      ? `${decodedValue} [formula: ${decodedFormula}]`
      : `[formula: ${decodedFormula}]`;
  }
  return decodedValue;
}

function worksheetText(
  xml: string,
  worksheetName: string,
  sharedStrings: string[],
) {
  const lines = [`[Worksheet: ${worksheetName}]`];
  for (const rowMatch of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/giu)) {
    const rowNumber = attributeValue(rowMatch[1], "r");
    const cells: string[] = [];
    for (const cellMatch of rowMatch[2].matchAll(
      /<c\b([^>]*)>([\s\S]*?)<\/c>/giu,
    )) {
      const reference = attributeValue(cellMatch[1], "r") || "?";
      const value = cellText(cellMatch[1], cellMatch[2], sharedStrings);
      if (value) cells.push(`${reference}=${value}`);
    }
    if (cells.length) {
      lines.push(`Row ${rowNumber || "?"}: ${cells.join(" | ")}`);
    }
  }
  return lines.join("\n");
}

function extractXlsx(archive: Record<string, Uint8Array>) {
  const workbook = xmlFile(archive, "xl/workbook.xml");
  const rels = relationshipMap(
    xmlFile(archive, "xl/_rels/workbook.xml.rels"),
  );
  const sharedStrings = extractSharedStrings(archive);
  const sheets = [
    ...workbook.matchAll(/<sheet\b([^>]*)\/?>/giu),
  ].map((match) => ({
    name: attributeValue(match[1], "name") || "Untitled",
    relationshipId: attributeValue(match[1], "r:id"),
  }));
  return sheets
    .map((sheet) => {
      const target = rels.get(sheet.relationshipId);
      if (!target) {
        throw uploadError(
          "FILE_CORRUPTED",
          "The Excel worksheet order could not be read.",
        );
      }
      return worksheetText(
        xmlFile(archive, officeTarget("xl", target)),
        sheet.name,
        sharedStrings,
      );
    })
    .join("\n\n");
}

function assertOfficeKind(
  archive: Record<string, Uint8Array>,
  extension: SupportedUploadExtension,
) {
  const requiredPaths: Partial<Record<SupportedUploadExtension, string>> = {
    ".docx": "word/document.xml",
    ".pptx": "ppt/presentation.xml",
    ".xlsx": "xl/workbook.xml",
  };
  const requiredPath = requiredPaths[extension];
  if (!requiredPath || !archive[requiredPath]) {
    throw uploadError(
      "FILE_TYPE_MISMATCH",
      "The file contents do not match its Microsoft Office extension.",
    );
  }
  const contentTypes = xmlFile(archive, "[Content_Types].xml");
  const expectedContentType = {
    ".docx":
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
    ".pptx":
      "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
    ".xlsx":
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
  }[extension as ".docx" | ".pptx" | ".xlsx"];
  if (!contentTypes.includes(expectedContentType)) {
    throw uploadError(
      "FILE_TYPE_MISMATCH",
      "The file contents do not match its Microsoft Office extension.",
    );
  }
}

async function extractPdf(bytes: Uint8Array) {
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>> | undefined;
  try {
    pdf = await getDocumentProxy(bytes, {
      disableFontFace: true,
      maxImageSize: 16_777_216,
      useSystemFonts: false,
    });
    if (pdf.numPages > PDF_MAX_PAGES) {
      throw uploadError(
        "FILE_TOO_COMPLEX",
        `PDFs with more than ${PDF_MAX_PAGES} pages cannot be processed.`,
      );
    }
    const extracted = await extractText(pdf, { mergePages: false });
    return extracted.text
      .map((page, index) => `[Page ${index + 1}]\n${page.trim()}`)
      .join("\n\n");
  } catch (error) {
    if (error instanceof AppError) throw error;
    const message = error instanceof Error ? `${error.name} ${error.message}` : "";
    if (/password|encrypted/iu.test(message)) {
      throw uploadError(
        "FILE_PASSWORD_PROTECTED",
        "Password-protected or encrypted PDF files cannot be processed.",
      );
    }
    throw uploadError(
      "FILE_CORRUPTED",
      "The PDF could not be read. It may be corrupted, incomplete, or password-protected.",
      400,
      error,
    );
  } finally {
    await pdf?.cleanup().catch(() => undefined);
  }
}

function withTimeout<T>(promise: Promise<T>) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timed = new Promise<T>((_, reject) => {
    timeout = setTimeout(
      () =>
        reject(
          uploadError(
            "FILE_PROCESSING_TIMEOUT",
            "The file took too long to process. Try a simpler file.",
            422,
          ),
        ),
      EXTRACTION_TIMEOUT_MS,
    );
  });
  return Promise.race([promise, timed]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

export async function validateUploadedFile(file: File): Promise<ValidatedUpload> {
  const metadata = validateUploadMetadata(file);
  if ("error" in metadata) {
    const code = file.size <= 0
      ? "FILE_EMPTY"
      : file.size > 10 * 1024 * 1024
        ? "FILE_TOO_LARGE"
        : "UNSUPPORTED_FILE";
    throw uploadError(code, metadata.error, file.size > 10 * 1024 * 1024 ? 413 : 400);
  }

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch (error) {
    throw uploadError(
      "FILE_UNREADABLE",
      "The selected file could not be read.",
      400,
      error,
    );
  }

  if (metadata.extension === ".pdf") assertPdfSignature(bytes);
  if (metadata.extension === ".png") assertPngSignature(bytes);
  if (metadata.extension === ".jpg" || metadata.extension === ".jpeg") {
    assertJpegSignature(bytes);
  }
  if (metadata.extension === ".webp") assertWebpSignature(bytes);
  if ([".docx", ".pptx", ".xlsx"].includes(metadata.extension)) {
    const entries = readZipEntries(bytes);
    const archive = unzipOffice(bytes, entries);
    assertOfficeKind(archive, metadata.extension);
  }

  return {
    bytes,
    ...metadata,
    safeName: sanitizeUploadFileName(file.name),
    size: file.size,
  };
}

export async function extractUploadedFile(file: File): Promise<ExtractedUpload> {
  const validated = await validateUploadedFile(file);
  const extraction = (async () => {
    if (validated.extension === ".pdf") return extractPdf(validated.bytes);
    if (isImageUploadMime(validated.mimeType)) {
      return analyzeUploadedImage(validated.bytes, validated.mimeType);
    }

    const entries = readZipEntries(validated.bytes);
    const archive = unzipOffice(validated.bytes, entries);
    if (validated.extension === ".docx") return extractDocx(archive);
    if (validated.extension === ".pptx") return extractPptx(archive);
    if (validated.extension === ".xlsx") return extractXlsx(archive);
    return "";
  })();

  const rawContent = await withTimeout(Promise.resolve(extraction));
  const result = sanitizeExtractedContent(rawContent);
  if (!result.content) {
    throw uploadError(
      "FILE_EMPTY",
      "No readable text or useful visual information was found in the file.",
      422,
    );
  }
  return { ...validated, ...result };
}
