import { lookup as nodeLookup } from "node:dns/promises";
import { isIP } from "node:net";

export interface BuildSourceContextInput {
  readonly draftText?: string;
  readonly sourceUrl?: string;
}

export interface SourceContextSnapshot {
  readonly url: string;
  readonly title: string;
  readonly articleText: string;
  readonly imageContext: string;
  readonly combinedFactualText: string;
}

export interface DnsAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export type SourceDnsLookup = (hostname: string) => Promise<readonly DnsAddress[]>;

export interface SourceContextLimits {
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  readonly maxRedirects: number;
  readonly maxDraftChars: number;
  readonly maxTitleChars: number;
  readonly maxArticleChars: number;
  readonly maxImageContextChars: number;
  readonly maxCombinedChars: number;
}

export interface SourceContextDependencies {
  readonly fetchImpl?: typeof fetch;
  readonly dnsLookup?: SourceDnsLookup;
  readonly limits?: Partial<SourceContextLimits>;
}

export type SourceContextErrorCode =
  | "INVALID_SOURCE_URL"
  | "NON_PUBLIC_SOURCE"
  | "SOURCE_DNS_FAILED"
  | "SOURCE_FETCH_FAILED"
  | "SOURCE_FETCH_TIMEOUT"
  | "SOURCE_REDIRECT_LIMIT"
  | "SOURCE_TOO_LARGE"
  | "UNSUPPORTED_SOURCE_TYPE";

export class SourceContextError extends Error {
  constructor(public readonly code: SourceContextErrorCode, message: string) {
    super(message);
    this.name = "SourceContextError";
  }
}

const DEFAULT_LIMITS: SourceContextLimits = Object.freeze({
  timeoutMs: 8_000,
  maxResponseBytes: 1_500_000,
  maxRedirects: 3,
  maxDraftChars: 24_000,
  maxTitleChars: 500,
  maxArticleChars: 32_000,
  maxImageContextChars: 8_000,
  maxCombinedChars: 66_000,
});

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const RAW_IGNORED_TAGS = ["script", "style", "noscript", "template", "svg"];
const IGNORED_TAGS = new Set([
  ...RAW_IGNORED_TAGS,
  "nav",
  "header",
  "footer",
  "aside",
  "form",
  "button",
  "iframe",
  "canvas",
  "dialog",
]);
const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);
const BLOCK_TAGS = new Set([
  "article",
  "blockquote",
  "div",
  "figcaption",
  "h1",
  "h2",
  "h3",
  "h4",
  "li",
  "main",
  "p",
  "section",
  "table",
  "td",
  "th",
  "tr",
]);
const ARTICLE_BLOCK_TAGS = new Set(["p", "blockquote", "h2", "h3"]);
const POSITIVE_CONTAINER_PATTERN = /(?:^|[-_\s])(article|articlecontent|articlebody|article-body|content|entry|news|post|story|storycontent|text)(?:$|[-_\s])/i;
const STRONG_ARTICLE_CONTAINER_PATTERN = /(?:articlecontent|articlebody|article-body|storycontent)/i;
const UNWANTED_CONTAINER_PATTERN = /(?:^|[-_\s])(ad|ads|advert|advertisement|articleurl|banner|breadcrumb|cookie|footer|footerads|header|list|menu|miscPanel|nav|newsletter|popup|promo|recommend|related|share|shareandtool|sidebar|social|sponsor)(?:$|[-_\s])/i;
const GENERIC_IMAGE_TEXT = /^(?:image|photo|picture|thumbnail|logo|icon|avatar|banner|advertisement|廣告|广告|圖片|图片|照片|圖像|图像)$/iu;

interface TextNode {
  readonly kind: "text";
  readonly value: string;
}

interface ElementNode {
  readonly kind: "element";
  readonly tag: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly children: HtmlNode[];
}

type HtmlNode = TextNode | ElementNode;

interface RetrievedSource {
  readonly url: string;
  readonly mediaType: string;
  readonly body: string;
}

const defaultDnsLookup: SourceDnsLookup = async (hostname) => {
  const addresses = await nodeLookup(hostname, { all: true, verbatim: true });
  return addresses.map(({ address, family }) => ({
    address,
    family: family === 6 ? 6 : 4,
  }));
};

export async function buildSourceContext(
  input: BuildSourceContextInput,
  dependencies: SourceContextDependencies = {},
): Promise<SourceContextSnapshot> {
  const limits = resolveLimits(dependencies.limits);
  const draftText = normalizeAndCap(input.draftText ?? "", limits.maxDraftChars);

  let url = "";
  let title = "";
  let articleText = "";
  let sourceImageContext = "";

  if (input.sourceUrl?.trim()) {
    const retrieved = await retrievePublicSource(input.sourceUrl, {
      fetchImpl: dependencies.fetchImpl ?? fetch,
      dnsLookup: dependencies.dnsLookup ?? defaultDnsLookup,
      limits,
    });
    url = retrieved.url;

    if (retrieved.mediaType === "text/html" || retrieved.mediaType === "application/xhtml+xml") {
      const extracted = extractHtmlSource(retrieved.body, limits);
      title = extracted.title;
      articleText = extracted.articleText;
      sourceImageContext = extracted.imageContext;
    } else {
      articleText = normalizeAndCap(retrieved.body, limits.maxArticleChars);
    }
  }

  const imageContext = normalizeAndCap(sourceImageContext, limits.maxImageContextChars);
  const combinedFactualText = buildCombinedText(
    { draftText, url, title, articleText, imageContext },
    limits.maxCombinedChars,
  );

  return Object.freeze({ url, title, articleText, imageContext, combinedFactualText });
}

function resolveLimits(overrides: Partial<SourceContextLimits> | undefined): SourceContextLimits {
  const positiveInteger = (value: number | undefined, fallback: number, ceiling: number) =>
    Number.isFinite(value) && (value ?? 0) > 0
      ? Math.min(Math.floor(value as number), ceiling)
      : fallback;
  const redirectLimit = Number.isFinite(overrides?.maxRedirects)
    ? Math.floor(overrides?.maxRedirects as number)
    : DEFAULT_LIMITS.maxRedirects;

  return Object.freeze({
    timeoutMs: positiveInteger(overrides?.timeoutMs, DEFAULT_LIMITS.timeoutMs, 30_000),
    maxResponseBytes: positiveInteger(
      overrides?.maxResponseBytes,
      DEFAULT_LIMITS.maxResponseBytes,
      5_000_000,
    ),
    maxRedirects: Math.min(3, Math.max(0, redirectLimit)),
    maxDraftChars: positiveInteger(
      overrides?.maxDraftChars,
      DEFAULT_LIMITS.maxDraftChars,
      100_000,
    ),
    maxTitleChars: positiveInteger(
      overrides?.maxTitleChars,
      DEFAULT_LIMITS.maxTitleChars,
      2_000,
    ),
    maxArticleChars: positiveInteger(
      overrides?.maxArticleChars,
      DEFAULT_LIMITS.maxArticleChars,
      100_000,
    ),
    maxImageContextChars: positiveInteger(
      overrides?.maxImageContextChars,
      DEFAULT_LIMITS.maxImageContextChars,
      30_000,
    ),
    maxCombinedChars: positiveInteger(
      overrides?.maxCombinedChars,
      DEFAULT_LIMITS.maxCombinedChars,
      150_000,
    ),
  });
}

async function retrievePublicSource(
  rawUrl: string,
  dependencies: Required<
    Pick<SourceContextDependencies, "fetchImpl" | "dnsLookup">
  > & { readonly limits: SourceContextLimits },
): Promise<RetrievedSource> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), dependencies.limits.timeoutMs);
  timer.unref?.();

  try {
    let currentUrl = parseSourceUrl(rawUrl);
    let redirectCount = 0;

    while (true) {
      await raceWithTimeout(
        assertPublicDestination(currentUrl, dependencies.dnsLookup),
        controller.signal,
      );

      let response: Response;
      try {
        response = await raceWithTimeout(
          dependencies.fetchImpl(currentUrl.href, {
            method: "GET",
            redirect: "manual",
            credentials: "omit",
            headers: {
              Accept: "text/html, application/xhtml+xml, text/plain;q=0.9, text/*;q=0.8",
              "User-Agent": "NewsDraftReviewer/1.0 (source-context fetch)",
            },
            signal: controller.signal,
          }),
          controller.signal,
        );
      } catch (error) {
        if (error instanceof SourceContextError) throw error;
        if (controller.signal.aborted || isAbortError(error)) throw timeoutError();
        throw new SourceContextError(
          "SOURCE_FETCH_FAILED",
          "The source page could not be retrieved.",
        );
      }

      if (response.redirected) {
        throw new SourceContextError(
          "SOURCE_FETCH_FAILED",
          "The source page returned an unsafe automatic redirect.",
        );
      }

      if (REDIRECT_STATUSES.has(response.status)) {
        if (redirectCount >= dependencies.limits.maxRedirects) {
          throw new SourceContextError(
            "SOURCE_REDIRECT_LIMIT",
            "The source page exceeded the redirect limit.",
          );
        }
        const location = response.headers.get("location");
        if (!location) {
          throw new SourceContextError(
            "SOURCE_FETCH_FAILED",
            "The source page returned an invalid redirect.",
          );
        }
        currentUrl = parseSourceUrl(new URL(location, currentUrl).href);
        redirectCount += 1;
        continue;
      }

      if (!response.ok) {
        throw new SourceContextError(
          "SOURCE_FETCH_FAILED",
          "The source page could not be retrieved.",
        );
      }

      const mediaType = getSupportedMediaType(response.headers.get("content-type"));
      const contentLength = parseContentLength(response.headers.get("content-length"));
      if (contentLength !== null && contentLength > dependencies.limits.maxResponseBytes) {
        await response.body?.cancel().catch(() => undefined);
        throw tooLargeError();
      }

      const bytes = await readLimitedBody(
        response,
        dependencies.limits.maxResponseBytes,
        controller.signal,
      );
      const body = decodeResponse(bytes, response.headers.get("content-type"));
      return Object.freeze({ url: currentUrl.href, mediaType, body });
    }
  } finally {
    clearTimeout(timer);
  }
}

function parseSourceUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new SourceContextError("INVALID_SOURCE_URL", "Enter a valid source URL.");
  }

  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    throw new SourceContextError(
      "INVALID_SOURCE_URL",
      "Only public HTTP or HTTPS source URLs without credentials are allowed.",
    );
  }
  parsed.hash = "";
  return parsed;
}

async function assertPublicDestination(url: URL, dnsLookup: SourceDnsLookup): Promise<void> {
  const hostname = stripIpv6Brackets(url.hostname).toLowerCase().replace(/\.$/, "");
  if (
    !hostname ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".lan")
  ) {
    throw nonPublicError();
  }

  const literalFamily = isIP(hostname);
  if (literalFamily !== 0) {
    if (!isPublicIpAddress(hostname)) throw nonPublicError();
    return;
  }

  let addresses: readonly DnsAddress[];
  try {
    addresses = await dnsLookup(hostname);
  } catch {
    throw new SourceContextError(
      "SOURCE_DNS_FAILED",
      "The source hostname could not be resolved.",
    );
  }

  if (addresses.length === 0) {
    throw new SourceContextError(
      "SOURCE_DNS_FAILED",
      "The source hostname could not be resolved.",
    );
  }
  if (addresses.some(({ address }) => !isPublicIpAddress(address))) {
    throw nonPublicError();
  }
}

function isPublicIpAddress(address: string): boolean {
  const normalized = stripIpv6Brackets(address).split("%")[0];
  const family = isIP(normalized);
  if (family === 4) return isPublicIpv4(normalized);
  if (family === 6) return isPublicIpv6(normalized);
  return false;
}

function isPublicIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }
  const value =
    (((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3]) >>> 0;
  const inRange = (base: number, prefix: number) => {
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return (value & mask) === (base & mask);
  };

  const blockedRanges: ReadonlyArray<readonly [number, number]> = [
    [0x00000000, 8],
    [0x0a000000, 8],
    [0x64400000, 10],
    [0x7f000000, 8],
    [0xa9fe0000, 16],
    [0xac100000, 12],
    [0xc0000000, 24],
    [0xc0000200, 24],
    [0xc0586300, 24],
    [0xc0a80000, 16],
    [0xc6120000, 15],
    [0xc6336400, 24],
    [0xcb007100, 24],
    [0xe0000000, 4],
    [0xf0000000, 4],
  ];
  return !blockedRanges.some(([base, prefix]) => inRange(base, prefix));
}

function isPublicIpv6(address: string): boolean {
  const words = parseIpv6Words(address);
  if (!words) return false;

  const allZero = words.every((word) => word === 0);
  const loopback = words.slice(0, 7).every((word) => word === 0) && words[7] === 1;
  if (allZero || loopback) return false;
  if ((words[0] & 0xff00) === 0xff00) return false;
  if ((words[0] & 0xfe00) === 0xfc00) return false;
  if ((words[0] & 0xffc0) === 0xfe80) return false;
  if ((words[0] & 0xffc0) === 0xfec0) return false;

  if (words[0] === 0x2001 && words[1] === 0x0db8) return false;
  if (words[0] === 0x2001 && words[1] === 0x0002) return false;
  if (words[0] === 0x2001 && (words[1] & 0xfff0) === 0x0010) return false;
  if (words[0] === 0x2001 && (words[1] & 0xfff0) === 0x0020) return false;
  if (words[0] === 0x2001 && words[1] === 0x0000) return false;
  if (words[0] === 0x0100 && words.slice(1, 4).every((word) => word === 0)) return false;

  const ipv4Mapped = words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff;
  const ipv4Compatible = words.slice(0, 6).every((word) => word === 0);
  if (ipv4Mapped || ipv4Compatible) {
    return isPublicIpv4(wordsToIpv4(words[6], words[7]));
  }

  if (words[0] === 0x2002) {
    return isPublicIpv4(wordsToIpv4(words[1], words[2]));
  }

  return (words[0] & 0xe000) === 0x2000;
}

function parseIpv6Words(address: string): number[] | null {
  let normalized = address.toLowerCase();
  const ipv4Match = normalized.match(/(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (ipv4Match) {
    const parts = ipv4Match[1].split(".").map(Number);
    if (parts.some((part) => part > 255)) return null;
    const replacement = `${((parts[0] << 8) | parts[1]).toString(16)}:${(
      (parts[2] << 8) |
      parts[3]
    ).toString(16)}`;
    normalized = normalized.slice(0, -ipv4Match[1].length) + replacement;
  }

  if (normalized.split("::").length > 2) return null;
  const [leftRaw, rightRaw] = normalized.split("::");
  const left = leftRaw ? leftRaw.split(":") : [];
  const right = rightRaw ? rightRaw.split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((normalized.includes("::") && missing < 1) || (!normalized.includes("::") && missing !== 0)) {
    return null;
  }
  const words = [
    ...left,
    ...Array.from({ length: missing }, () => "0"),
    ...right,
  ].map((part) => (/^[0-9a-f]{1,4}$/.test(part) ? Number.parseInt(part, 16) : -1));
  return words.length === 8 && words.every((word) => word >= 0) ? words : null;
}

function wordsToIpv4(high: number, low: number): string {
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

function getSupportedMediaType(contentType: string | null): string {
  const mediaType = (contentType ?? "text/plain").split(";", 1)[0].trim().toLowerCase();
  if (mediaType === "text/html" || mediaType === "application/xhtml+xml") return mediaType;
  if (mediaType.startsWith("text/")) return "text/plain";
  throw new SourceContextError(
    "UNSUPPORTED_SOURCE_TYPE",
    "The source must be an HTML or plain-text page.",
  );
}

function parseContentLength(header: string | null): number | null {
  if (!header || !/^\d+$/.test(header.trim())) return null;
  const value = Number(header);
  return Number.isSafeInteger(value) ? value : null;
}

async function readLimitedBody(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await raceWithTimeout(reader.read(), signal);
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw tooLargeError();
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof SourceContextError) throw error;
    if (signal.aborted || isAbortError(error)) throw timeoutError();
    throw new SourceContextError(
      "SOURCE_FETCH_FAILED",
      "The source page could not be read.",
    );
  }

  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

function decodeResponse(bytes: Uint8Array, contentType: string | null): string {
  const charset = contentType?.match(/charset\s*=\s*["']?([^;"'\s]+)/i)?.[1] ?? "utf-8";
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

function raceWithTimeout<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(timeoutError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(timeoutError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function extractHtmlSource(
  html: string,
  limits: SourceContextLimits,
): Pick<SourceContextSnapshot, "title" | "articleText" | "imageContext"> {
  const root = parseHtml(html);
  const candidate = chooseArticleContainer(root);
  const title = normalizeAndCap(findTitle(root, candidate), limits.maxTitleChars);
  const blocks = collectArticleBlocks(candidate)
    .map((block) => normalizeText(block))
    .filter((block) => block.length > 0 && block !== title);
  const dedupedBlocks = dedupe(blocks);
  const fallback = normalizeText(renderedText(candidate));
  const articleText = normalizeAndCap(
    dedupedBlocks.length > 0 ? dedupedBlocks.join("\n\n") : fallback,
    limits.maxArticleChars,
  );
  const imageContext = normalizeAndCap(
    collectSourceImageContext(root).join("\n"),
    limits.maxImageContextChars,
  );
  return { title, articleText, imageContext };
}

function parseHtml(html: string): ElementNode {
  let sanitized = html.replace(/<!--[^]*?-->/g, " ");
  for (const tag of RAW_IGNORED_TAGS) {
    sanitized = sanitized.replace(new RegExp(`<${tag}\\b[^>]*>[^]*?<\\/${tag}\\s*>`, "gi"), " ");
  }

  const root: ElementNode = { kind: "element", tag: "root", attributes: {}, children: [] };
  const stack: ElementNode[] = [root];
  const tokens = sanitized.match(/<![^>]*>|<\/?[^>]+>|[^<]+/g) ?? [];

  for (const token of tokens) {
    if (!token.startsWith("<")) {
      stack.at(-1)?.children.push({ kind: "text", value: token });
      continue;
    }
    if (/^<!/i.test(token)) continue;
    const closing = token.match(/^<\s*\/\s*([a-zA-Z0-9:-]+)/);
    if (closing) {
      const tag = closing[1].toLowerCase();
      for (let index = stack.length - 1; index > 0; index -= 1) {
        if (stack[index].tag === tag) {
          stack.length = index;
          break;
        }
      }
      continue;
    }

    const opening = token.match(/^<\s*([a-zA-Z0-9:-]+)([^>]*)>/);
    if (!opening) continue;
    const tag = opening[1].toLowerCase();
    const node: ElementNode = {
      kind: "element",
      tag,
      attributes: parseAttributes(opening[2]),
      children: [],
    };
    stack.at(-1)?.children.push(node);
    if (!VOID_TAGS.has(tag) && !/\/\s*>$/.test(token)) stack.push(node);
  }
  return root;
}

function parseAttributes(source: string): Readonly<Record<string, string>> {
  const attributes: Record<string, string> = {};
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) {
    attributes[match[1].toLowerCase()] = decodeHtmlEntities(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attributes;
}

function chooseArticleContainer(root: ElementNode): ElementNode {
  let best = root;
  let bestScore = -Infinity;

  walkElements(root, (node) => {
    if (!isUsableElement(node)) return false;
    if (!["root", "body", "main", "article", "section", "div"].includes(node.tag)) return true;
    const text = normalizeText(renderedText(node));
    if (text.length < 60 && node.tag !== "root") return true;
    const attributes = `${node.attributes.id ?? ""} ${node.attributes.class ?? ""} ${
      node.attributes.itemprop ?? ""
    }`;
    const paragraphCount = countDescendants(node, (item) => item.tag === "p");
    const punctuationCount = (text.match(/[。！？.!?]/g) ?? []).length;
    const linkChars = descendantTextLength(node, "a");
    const tagBonus = node.tag === "article" ? 2_800 : node.tag === "main" ? 2_000 : 0;
    const itemPropBonus = /articlebody/i.test(node.attributes.itemprop ?? "") ? 3_000 : 0;
    const attributeBonus = STRONG_ARTICLE_CONTAINER_PATTERN.test(attributes)
      ? 6_000
      : POSITIVE_CONTAINER_PATTERN.test(attributes)
        ? 1_300
        : 0;
    const linkPenalty = text.length > 0 ? (linkChars / text.length) * 2_000 : 0;
    const score =
      Math.min(text.length, 20_000) +
      paragraphCount * 180 +
      Math.min(punctuationCount, 100) * 20 +
      tagBonus +
      itemPropBonus +
      attributeBonus -
      linkPenalty;
    if (score > bestScore) {
      best = node;
      bestScore = score;
    }
    return true;
  });
  return best;
}

function findTitle(root: ElementNode, candidate: ElementNode): string {
  let metaTitle = "";
  let documentTitle = "";
  let candidateHeading = "";
  let firstHeading = "";

  walkElements(root, (node) => {
    if (!isUsableElement(node)) return false;
    if (node.tag === "meta") {
      const key = (node.attributes.property ?? node.attributes.name ?? "").toLowerCase();
      if (!metaTitle && (key === "og:title" || key === "twitter:title")) {
        metaTitle = node.attributes.content ?? "";
      }
    } else if (node.tag === "title" && !documentTitle) {
      documentTitle = renderedText(node);
    } else if (node.tag === "h1" && !firstHeading) {
      firstHeading = renderedText(node);
    }
    return true;
  });
  walkElements(candidate, (node) => {
    if (!isUsableElement(node)) return false;
    if (node.tag === "h1" && !candidateHeading) candidateHeading = renderedText(node);
    return !candidateHeading;
  });
  return decodeHtmlEntities(candidateHeading || metaTitle || firstHeading || documentTitle);
}

function collectArticleBlocks(candidate: ElementNode): string[] {
  const blocks: string[] = [];
  walkElements(candidate, (node) => {
    if (!isUsableElement(node)) return false;
    const classTokens = (node.attributes.class ?? "")
      .toLowerCase()
      .split(/\s+/u)
      .filter(Boolean);
    const isPublisherTextBlock =
      node.tag === "div" &&
      (classTokens.includes("content") || classTokens.includes("subtitle"));
    if (ARTICLE_BLOCK_TAGS.has(node.tag) || isPublisherTextBlock) {
      blocks.push(renderedText(node));
      return false;
    }
    return true;
  });
  return blocks;
}

function collectSourceImageContext(root: ElementNode): string[] {
  const items: string[] = [];
  walkElements(root, (node) => {
    if (!isUsableElement(node)) return false;
    if (node.tag === "figcaption") {
      const caption = normalizeText(renderedText(node));
      if (isMeaningfulImageText(caption)) items.push(`Source image caption: ${caption}`);
    } else if (node.tag === "img") {
      const alt = normalizeText(node.attributes.alt ?? "");
      if (isMeaningfulImageText(alt)) items.push(`Source image description: ${alt}`);
    }
    return true;
  });
  return dedupe(items);
}

function renderedText(node: HtmlNode): string {
  if (node.kind === "text") return decodeHtmlEntities(node.value);
  if (!isUsableElement(node)) return "";
  const parts: string[] = [];
  for (const child of node.children) {
    const value = renderedText(child);
    if (!value) continue;
    if (child.kind === "element" && (BLOCK_TAGS.has(child.tag) || child.tag === "br")) {
      parts.push(`\n${value}\n`);
    } else {
      parts.push(value);
    }
  }
  return parts.join(" ");
}

function walkElements(node: ElementNode, visitor: (node: ElementNode) => boolean): void {
  if (!visitor(node)) return;
  for (const child of node.children) {
    if (child.kind === "element") walkElements(child, visitor);
  }
}

function isUsableElement(node: ElementNode): boolean {
  if (IGNORED_TAGS.has(node.tag)) return false;
  if ("hidden" in node.attributes || node.attributes["aria-hidden"] === "true") return false;
  const role = (node.attributes.role ?? "").toLowerCase();
  if (["banner", "complementary", "contentinfo", "navigation"].includes(role)) return false;
  const identity = `${node.attributes.id ?? ""} ${node.attributes.class ?? ""}`;
  return !UNWANTED_CONTAINER_PATTERN.test(identity);
}

function countDescendants(node: ElementNode, predicate: (node: ElementNode) => boolean): number {
  let count = 0;
  walkElements(node, (item) => {
    if (!isUsableElement(item)) return false;
    if (predicate(item)) count += 1;
    return true;
  });
  return count;
}

function descendantTextLength(node: ElementNode, tag: string): number {
  let length = 0;
  walkElements(node, (item) => {
    if (!isUsableElement(item)) return false;
    if (item.tag === tag) {
      length += normalizeText(renderedText(item)).length;
      return false;
    }
    return true;
  });
  return length;
}

function isMeaningfulImageText(value: string): boolean {
  if (value.length < 2 || GENERIC_IMAGE_TEXT.test(value)) return false;
  if (/\.(?:avif|gif|jpe?g|png|svg|webp)(?:\?.*)?$/i.test(value)) return false;
  return /[\p{L}\p{N}]/u.test(value);
}

function buildCombinedText(
  fields: {
    readonly draftText: string;
    readonly url: string;
    readonly title: string;
    readonly articleText: string;
    readonly imageContext: string;
  },
  maxChars: number,
): string {
  const sections: string[] = [];
  if (fields.draftText) sections.push(`[Submitted draft — verify its claims]\n${fields.draftText}`);
  if (fields.url) sections.push(`[Retrieved source URL]\n${fields.url}`);
  if (fields.title) sections.push(`[Retrieved source title]\n${fields.title}`);
  if (fields.articleText) sections.push(`[Retrieved source article]\n${fields.articleText}`);
  if (fields.imageContext) sections.push(`[Image text]\n${fields.imageContext}`);
  return normalizeAndCap(sections.join("\n\n"), maxChars);
}

function decodeHtmlEntities(value: string): string {
  const named: Readonly<Record<string, string>> = {
    amp: "&",
    apos: "'",
    gt: ">",
    hellip: "…",
    laquo: "«",
    ldquo: "“",
    lsquo: "‘",
    lt: "<",
    mdash: "—",
    middot: "·",
    nbsp: " ",
    ndash: "–",
    quot: '"',
    raquo: "»",
    rdquo: "”",
    rsquo: "’",
  };
  return value.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z][a-z0-9]+));/gi, (entity, decimal, hex, name) => {
    if (decimal) return safeCodePoint(Number.parseInt(decimal, 10), entity);
    if (hex) return safeCodePoint(Number.parseInt(hex, 16), entity);
    return named[String(name).toLowerCase()] ?? entity;
  });
}

function safeCodePoint(codePoint: number, fallback: string): string {
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return fallback;
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return fallback;
  }
}

function normalizeText(value: string): string {
  return value
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/[\t\f\v\u00a0\u2007\u202f]+/g, " ")
    .split("\n")
    .map((line) => line.replace(/ +/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeAndCap(value: string, maxChars: number): string {
  const normalized = normalizeText(value);
  if (normalized.length <= maxChars) return normalized;
  return Array.from(normalized).slice(0, maxChars).join("").trimEnd();
}

function dedupe(values: readonly string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = normalizeText(value);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function nonPublicError(): SourceContextError {
  return new SourceContextError(
    "NON_PUBLIC_SOURCE",
    "The source URL must resolve only to public internet addresses.",
  );
}

function tooLargeError(): SourceContextError {
  return new SourceContextError("SOURCE_TOO_LARGE", "The source page is too large to process safely.");
}

function timeoutError(): SourceContextError {
  return new SourceContextError("SOURCE_FETCH_TIMEOUT", "The source page took too long to retrieve.");
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
