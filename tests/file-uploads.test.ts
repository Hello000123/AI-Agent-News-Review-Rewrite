import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  extractUploadedFile,
  validateUploadedFile,
} from "@/lib/server/uploads/file-processing";
import {
  MAX_UPLOAD_BYTES,
  SUPPORTED_UPLOADS,
  validateUploadMetadata,
  type SupportedUploadExtension,
} from "@/lib/shared/file-upload";

const MIME_BY_EXTENSION = Object.fromEntries(
  Object.entries(SUPPORTED_UPLOADS).map(([extension, value]) => [
    extension,
    value.mimeTypes[0],
  ]),
) as Record<SupportedUploadExtension, string>;

function fileFromBytes(
  bytes: Uint8Array,
  name: string,
  type = MIME_BY_EXTENSION[name.slice(name.lastIndexOf(".")) as SupportedUploadExtension],
) {
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  return new File([buffer], name, { type });
}

function xml(value: string) {
  return strToU8(value);
}

function officeArchive(
  extension: ".docx" | ".pptx" | ".xlsx",
  entries: Record<string, Uint8Array>,
) {
  const mainContentType = {
    ".docx":
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
    ".pptx":
      "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
    ".xlsx":
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
  }[extension];
  return zipSync({
    "[Content_Types].xml": xml(
      `<Types><Override PartName="/main" ContentType="${mainContentType}"/></Types>`,
    ),
    ...entries,
  });
}

function validDocx() {
  return officeArchive(".docx", {
    "word/document.xml": xml(
      `<w:document xmlns:w="w"><w:body>
        <w:p><w:r><w:t>First paragraph</w:t></w:r></w:p>
        <w:p><w:r><w:t>Second &amp; final paragraph</w:t></w:r></w:p>
      </w:body></w:document>`,
    ),
  });
}

function validPptx() {
  return officeArchive(".pptx", {
    "ppt/presentation.xml": xml(
      `<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst>
        <p:sldId id="2" r:id="rIdSecond"/>
        <p:sldId id="1" r:id="rIdFirst"/>
      </p:sldIdLst></p:presentation>`,
    ),
    "ppt/_rels/presentation.xml.rels": xml(
      `<Relationships>
        <Relationship Id="rIdFirst" Target="slides/slide1.xml"/>
        <Relationship Id="rIdSecond" Target="slides/slide2.xml"/>
      </Relationships>`,
    ),
    "ppt/slides/slide1.xml": xml(
      `<p:sld xmlns:p="p" xmlns:a="a"><a:p><a:r><a:t>Original first slide</a:t></a:r></a:p></p:sld>`,
    ),
    "ppt/slides/slide2.xml": xml(
      `<p:sld xmlns:p="p" xmlns:a="a"><a:p><a:r><a:t>Reordered opening slide</a:t></a:r></a:p></p:sld>`,
    ),
  });
}

function validXlsx() {
  return officeArchive(".xlsx", {
    "xl/workbook.xml": xml(
      `<workbook xmlns:r="r"><sheets>
        <sheet name="Summary" sheetId="2" r:id="rIdSummary"/>
        <sheet name="Data" sheetId="1" r:id="rIdData"/>
      </sheets></workbook>`,
    ),
    "xl/_rels/workbook.xml.rels": xml(
      `<Relationships>
        <Relationship Id="rIdData" Target="worksheets/sheet1.xml"/>
        <Relationship Id="rIdSummary" Target="worksheets/sheet2.xml"/>
      </Relationships>`,
    ),
    "xl/sharedStrings.xml": xml(
      `<sst><si><t>Headline</t></si><si><t>Confirmed</t></si></sst>`,
    ),
    "xl/worksheets/sheet1.xml": xml(
      `<worksheet><sheetData><row r="1">
        <c r="A1" t="s"><v>0</v></c><c r="B1"><v>42</v></c>
      </row></sheetData></worksheet>`,
    ),
    "xl/worksheets/sheet2.xml": xml(
      `<worksheet><sheetData><row r="3">
        <c r="C3" t="s"><v>1</v></c><c r="D3"><f>1+1</f><v>2</v></c>
      </row></sheetData></worksheet>`,
    ),
  });
}

function validPdf(text = "First PDF line") {
  const encoder = new TextEncoder();
  const content = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${encoder.encode(content).length} >>\nstream\n${content}\nendstream`,
  ];
  let output = "%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(encoder.encode(output).length);
    output += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = encoder.encode(output).length;
  output += `xref\n0 ${objects.length + 1}\n`;
  output += "0000000000 65535 f \n";
  output += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  output += `startxref\n${xrefOffset}\n%%EOF\n`;
  return encoder.encode(output);
}

const validPng = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  ),
);
const validJpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0, 0, 0xff, 0xd9]);
const validWebp = Uint8Array.from([
  0x52, 0x49, 0x46, 0x46, 12, 0, 0, 0,
  0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20,
  0, 0, 0, 0,
]);

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("upload metadata validation", () => {
  it.each(Object.keys(SUPPORTED_UPLOADS) as SupportedUploadExtension[])(
    "accepts a valid %s extension and MIME pair",
    (extension) => {
      expect(
        validateUploadMetadata({
          name: `news${extension}`,
          type: MIME_BY_EXTENSION[extension],
          size: 1,
        }),
      ).toMatchObject({ extension });
    },
  );

  it.each(Object.keys(SUPPORTED_UPLOADS) as SupportedUploadExtension[])(
    "rejects oversized %s files",
    (extension) => {
      expect(
        validateUploadMetadata({
          name: `news${extension}`,
          type: MIME_BY_EXTENSION[extension],
          size: MAX_UPLOAD_BYTES + 1,
        }),
      ).toEqual({ error: "The selected file is larger than the 10 MB limit." });
    },
  );

  it.each(Object.keys(SUPPORTED_UPLOADS) as SupportedUploadExtension[])(
    "rejects an empty %s file",
    (extension) => {
      expect(
        validateUploadMetadata({
          name: `news${extension}`,
          type: MIME_BY_EXTENSION[extension],
          size: 0,
        }),
      ).toEqual({ error: "The selected file is empty." });
    },
  );

  it.each(Object.keys(SUPPORTED_UPLOADS) as SupportedUploadExtension[])(
    "rejects a %s file with a misleading MIME type",
    (extension) => {
      expect(
        validateUploadMetadata({
          name: `news${extension}`,
          type: "application/octet-stream",
          size: 1,
        }),
      ).toMatchObject({ error: expect.stringContaining("does not match") });
    },
  );

  it("rejects unsupported extensions and misleading MIME types", () => {
    expect(
      validateUploadMetadata({
        name: "notes.txt",
        type: "text/plain",
        size: 10,
      }),
    ).toMatchObject({ error: expect.stringContaining("Unsupported") });
    expect(
      validateUploadMetadata({
        name: "renamed.pdf",
        type: "image/png",
        size: 10,
      }),
    ).toMatchObject({ error: expect.stringContaining("does not match") });
  });
});

describe("server file validation and extraction", () => {
  it("extracts PDF pages and DOCX paragraphs in reading order", async () => {
    const pdf = await extractUploadedFile(
      fileFromBytes(validPdf(), "briefing.pdf"),
    );
    expect(pdf.content).toContain("[Page 1]");
    expect(pdf.content).toContain("First PDF line");

    const docx = await extractUploadedFile(
      fileFromBytes(validDocx(), "briefing.docx"),
    );
    expect(docx.content).toBe(
      "First paragraph\nSecond & final paragraph",
    );
  });

  it("uses presentation relationships to preserve the actual slide order", async () => {
    const result = await extractUploadedFile(
      fileFromBytes(validPptx(), "briefing.pptx"),
    );
    expect(result.content).toBe(
      "[Slide 1]\nReordered opening slide\n\n[Slide 2]\nOriginal first slide",
    );
  });

  it("preserves workbook sheet order, row numbers, cell references, and formulas", async () => {
    const result = await extractUploadedFile(
      fileFromBytes(validXlsx(), "figures.xlsx"),
    );
    expect(result.content).toContain(
      "[Worksheet: Summary]\nRow 3: C3=Confirmed | D3=2 [formula: 1+1]",
    );
    expect(result.content).toContain(
      "[Worksheet: Data]\nRow 1: A1=Headline | B1=42",
    );
    expect(result.content.indexOf("[Worksheet: Summary]")).toBeLessThan(
      result.content.indexOf("[Worksheet: Data]"),
    );
  });

  it.each([
    [".png", "image/png", validPng],
    [".jpg", "image/jpeg", validJpeg],
    [".jpeg", "image/jpeg", validJpeg],
    [".webp", "image/webp", validWebp],
  ] as const)("uses OCR and visual analysis for valid %s images", async (
    extension,
    mimeType,
    bytes,
  ) => {
    vi.stubEnv("XAI_API_KEY", "test-key");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: "Visible text\nCouncil briefing\n\nVisual context\nA chart is shown.",
                },
              },
            ],
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
    const result = await extractUploadedFile(
      fileFromBytes(bytes, `image${extension}`, mimeType),
    );
    expect(result.content).toContain("Council briefing");
    expect(result.content).toContain("Visual context");
  });

  it.each(Object.keys(SUPPORTED_UPLOADS) as SupportedUploadExtension[])(
    "rejects corrupted %s content with a clear safe error",
    async (extension) => {
      await expect(
        validateUploadedFile(
          fileFromBytes(
            Uint8Array.from([1, 2, 3, 4]),
            `corrupt${extension}`,
          ),
        ),
      ).rejects.toMatchObject({
        code: expect.stringMatching(/FILE_(?:CORRUPTED|TYPE_MISMATCH)/u),
      });
    },
  );

  it("rejects password-protected PDFs and encrypted Office containers", async () => {
    const encryptedPdf = new TextEncoder().encode(
      "%PDF-1.7\n1 0 obj << /Encrypt 2 0 R >> endobj\n%%EOF\n",
    );
    await expect(
      validateUploadedFile(fileFromBytes(encryptedPdf, "private.pdf")),
    ).rejects.toMatchObject({ code: "FILE_PASSWORD_PROTECTED" });

    const oleHeader = Uint8Array.from([
      0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0,
    ]);
    for (const extension of [".docx", ".pptx", ".xlsx"] as const) {
      await expect(
        validateUploadedFile(
          fileFromBytes(oleHeader, `protected${extension}`),
        ),
      ).rejects.toMatchObject({ code: "FILE_PASSWORD_PROTECTED" });
    }
  });

  it("rejects incorrectly renamed files and Office macro payloads", async () => {
    await expect(
      validateUploadedFile(
        fileFromBytes(
          validPng,
          "renamed.docx",
          MIME_BY_EXTENSION[".docx"],
        ),
      ),
    ).rejects.toMatchObject({ code: "FILE_TYPE_MISMATCH" });

    const macroDocument = officeArchive(".docx", {
      "word/document.xml": xml("<w:document/>"),
      "word/vbaProject.bin": Uint8Array.from([1, 2, 3]),
    });
    await expect(
      validateUploadedFile(fileFromBytes(macroDocument, "macro.docx")),
    ).rejects.toMatchObject({ code: "FILE_UNSAFE" });
  });
});
