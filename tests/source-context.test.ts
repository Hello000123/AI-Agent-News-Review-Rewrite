import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildSourceContext,
  type SourceDnsLookup,
} from "@/lib/server/sources/source-context";

const ORIENTAL_URL =
  "https://orientaldaily.on.cc/content/%E8%A6%81%E8%81%9E%E6%B8%AF%E8%81%9E/odn-20260716-test";

const publicDns: SourceDnsLookup = vi.fn(async () => [
  { address: "93.184.216.34", family: 4 as const },
  { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 as const },
]);

function response(body: BodyInit | null, init: ResponseInit = {}): Response {
  return new Response(body, {
    status: init.status ?? 200,
    headers: { "Content-Type": "text/html; charset=utf-8", ...init.headers },
  });
}

describe("source context", () => {
  afterEach(() => vi.useRealTimers());

  it("extracts an immutable Oriental-style article and keeps useful image and draft text", async () => {
    const html = `
      <!doctype html>
      <html lang="zh-Hant">
        <head>
          <title>網站標題</title>
          <meta property="og:title" content="DSE誕24狀元創歷史 20人留港讀醫">
          <script>window.secretArticle = "must not appear";</script>
          <style>.story { color: red }</style>
        </head>
        <body>
          <nav class="top-nav">主頁 要聞 港聞</nav>
          <div class="advertisement">立即購買廣告產品</div>
          <article id="story-content" itemprop="articleBody">
            <h1>DSE誕24狀元創歷史 20人留港讀醫</h1>
            <div class="article-content">
              <p>中學文憑試昨日放榜，本屆誕生24名狀元，創歷史新高。</p>
              <p>其中20人表示會留港讀醫，教育界稱結果令人鼓舞。</p>
              <p>考生說：「我會繼續努力，服務香港。」</p>
              <p>其中20人表示會留港讀醫，教育界稱結果令人鼓舞。</p>
              <figure>
                <img src="candidate.jpg" alt="考生在校內與老師合照">
                <figcaption>應屆考生分享放榜感受。</figcaption>
              </figure>
            </div>
            <aside class="related-news">更多新聞：不應抽取</aside>
          </article>
          <img src="brand.svg" alt="logo">
          <footer>版權及私隱聲明</footer>
        </body>
      </html>`;
    const fetchMock = vi.fn().mockResolvedValue(response(html));
    const input = {
      draftText: "  初稿指出本屆共有24名狀元。  ",
      sourceUrl: `${ORIENTAL_URL}#comments`,
      imageInputs: [
        { caption: "用戶上載的成績單", ocrText: "狀元人數：24" },
      ],
    } as const;

    const snapshot = await buildSourceContext(input, {
      fetchImpl: fetchMock as unknown as typeof fetch,
      dnsLookup: publicDns,
    });

    expect(snapshot).toEqual(
      expect.objectContaining({
        url: ORIENTAL_URL,
        title: "DSE誕24狀元創歷史 20人留港讀醫",
      }),
    );
    expect(snapshot.articleText).toContain("本屆誕生24名狀元");
    expect(snapshot.articleText).toContain("考生說：「我會繼續努力，服務香港。」");
    expect(snapshot.articleText.match(/其中20人表示/g)).toHaveLength(1);
    expect(snapshot.articleText).not.toMatch(/主頁|廣告產品|更多新聞|版權|secretArticle/);
    expect(snapshot.imageContext).toContain("Source image description: 考生在校內與老師合照");
    expect(snapshot.imageContext).toContain("Source image caption: 應屆考生分享放榜感受。");
    expect(snapshot.imageContext).toContain("User image 1 caption: 用戶上載的成績單");
    expect(snapshot.imageContext).toContain("User image 1 OCR: 狀元人數：24");
    expect(snapshot.imageContext).not.toContain("logo");
    expect(snapshot.combinedFactualText).toContain("[Submitted draft — verify its claims]");
    expect(snapshot.combinedFactualText).toContain("[Retrieved source article]");
    expect(snapshot.combinedFactualText).toContain("[Image text]");
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(input.draftText).toBe("  初稿指出本屆共有24名狀元。  ");

    const [, requestInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(requestInit).toMatchObject({
      method: "GET",
      redirect: "manual",
      credentials: "omit",
    });
    expect(requestInit.headers).not.toHaveProperty("Authorization");
    expect(requestInit.headers).not.toHaveProperty("Cookie");
  });

  it("handles div-based publisher copy without duplicate headlines or footer promotions", async () => {
    const html = `
      <html><head><meta property="og:title" content="DSE headline"></head><body><main>
        <div class="articleContent">
          <div class="shareAndTool">Share this article</div>
          <h1 class="title">DSE headline</h1>
          <div class="paragraph leadin"><div class="subtitle">News subheading</div><div class="content">The complete lead reports 24 results and identifies the central development clearly.</div></div>
          <div class="paragraph"><div class="content">A second paragraph provides attributed supporting detail for the report.</div></div>
          <div class="footerAds">Download our app and contact the newsroom.</div>
          <div id="miscPanel"><div class="articleUrl">Article link and promotional text</div></div>
        </div>
      </main></body></html>`;
    const context = await buildSourceContext(
      { sourceUrl: "https://example.com/article" },
      {
        fetchImpl: vi.fn().mockResolvedValue(response(html)) as unknown as typeof fetch,
        dnsLookup: publicDns,
      },
    );

    expect(context.title).toBe("DSE headline");
    expect(context.articleText).toBe(
      "News subheading\n\nThe complete lead reports 24 results and identifies the central development clearly.\n\nA second paragraph provides attributed supporting detail for the report.",
    );
    expect(context.articleText).not.toContain("DSE headline");
    expect(context.articleText).not.toContain("Download our app");
    expect(context.articleText).not.toContain("Article link");
  });

  it("supports text-only pages and local draft/image-only snapshots", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("  First fact.\r\n\r\nSecond fact.  ", {
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      }),
    );
    const fetched = await buildSourceContext(
      { sourceUrl: "https://news.example/story.txt" },
      { fetchImpl: fetchMock as unknown as typeof fetch, dnsLookup: publicDns },
    );
    expect(fetched.articleText).toBe("First fact.\n\nSecond fact.");

    const noFetch = vi.fn();
    const local = await buildSourceContext(
      { draftText: "Local draft", imageInputs: [{ ocrText: "Image fact" }] },
      { fetchImpl: noFetch as unknown as typeof fetch, dnsLookup: publicDns },
    );
    expect(local).toMatchObject({ url: "", title: "", articleText: "" });
    expect(local.combinedFactualText).toContain("Local draft");
    expect(local.combinedFactualText).toContain("Image fact");
    expect(noFetch).not.toHaveBeenCalled();
  });

  it.each([
    "http://localhost/admin",
    "http://127.0.0.1/admin",
    "http://169.254.169.254/latest/meta-data",
    "http://10.2.3.4/internal",
    "http://[::1]/admin",
    "http://[::ffff:127.0.0.1]/admin",
    "ftp://example.com/story",
    "https://user:password@example.com/story",
  ])("rejects a non-public or credential-bearing URL before fetching: %s", async (sourceUrl) => {
    const fetchMock = vi.fn();
    await expect(
      buildSourceContext(
        { sourceUrl },
        { fetchImpl: fetchMock as unknown as typeof fetch, dnsLookup: publicDns },
      ),
    ).rejects.toMatchObject({ code: expect.stringMatching(/NON_PUBLIC_SOURCE|INVALID_SOURCE_URL/) });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a hostname if any DNS answer is private", async () => {
    const dnsLookup: SourceDnsLookup = vi.fn(async () => [
      { address: "93.184.216.34", family: 4 as const },
      { address: "192.168.1.20", family: 4 as const },
    ]);
    const fetchMock = vi.fn();
    await expect(
      buildSourceContext(
        { sourceUrl: "https://mixed-dns.example/story" },
        { fetchImpl: fetchMock as unknown as typeof fetch, dnsLookup },
      ),
    ).rejects.toMatchObject({ code: "NON_PUBLIC_SOURCE" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("validates every redirect destination before following it", async () => {
    const dnsLookup: SourceDnsLookup = vi.fn(async (hostname) =>
      hostname === "private-target.example"
        ? [{ address: "172.16.0.8", family: 4 as const }]
        : [{ address: "93.184.216.34", family: 4 as const }],
    );
    const fetchMock = vi.fn().mockResolvedValue(
      response(null, {
        status: 302,
        headers: { Location: "http://private-target.example/secret" },
      }),
    );

    await expect(
      buildSourceContext(
        { sourceUrl: "https://public.example/start" },
        { fetchImpl: fetchMock as unknown as typeof fetch, dnsLookup },
      ),
    ).rejects.toMatchObject({ code: "NON_PUBLIC_SOURCE" });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(dnsLookup).toHaveBeenCalledWith("private-target.example");
  });

  it("allows at most three checked redirects", async () => {
    let requestNumber = 0;
    const fetchMock = vi.fn(async () => {
      requestNumber += 1;
      return response(null, {
        status: 302,
        headers: { Location: `/redirect-${requestNumber}` },
      });
    });

    await expect(
      buildSourceContext(
        { sourceUrl: "https://public.example/start" },
        {
          fetchImpl: fetchMock as unknown as typeof fetch,
          dnsLookup: publicDns,
          // Caller overrides can tighten this, but can never raise the hard ceiling.
          limits: { maxRedirects: 99 },
        },
      ),
    ).rejects.toMatchObject({ code: "SOURCE_REDIRECT_LIMIT" });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("accepts a safe checked redirect and returns the final normalized URL", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(null, { status: 301, headers: { Location: "/final#part" } }))
      .mockResolvedValueOnce(
        new Response("Final article.", { headers: { "Content-Type": "text/plain" } }),
      );
    const result = await buildSourceContext(
      { sourceUrl: "https://public.example/start" },
      { fetchImpl: fetchMock as unknown as typeof fetch, dnsLookup: publicDns },
    );
    expect(result.url).toBe("https://public.example/final");
    expect(result.articleText).toBe("Final article.");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects declared and streamed bodies over the byte limit", async () => {
    const declaredFetch = vi.fn().mockResolvedValue(
      response("small", { headers: { "Content-Length": "101" } }),
    );
    await expect(
      buildSourceContext(
        { sourceUrl: "https://public.example/declared" },
        {
          fetchImpl: declaredFetch as unknown as typeof fetch,
          dnsLookup: publicDns,
          limits: { maxResponseBytes: 100 },
        },
      ),
    ).rejects.toMatchObject({ code: "SOURCE_TOO_LARGE" });

    const streamedFetch = vi.fn().mockResolvedValue(
      new Response("This UTF-8 body is larger than ten bytes.", {
        headers: { "Content-Type": "text/plain" },
      }),
    );
    await expect(
      buildSourceContext(
        { sourceUrl: "https://public.example/streamed" },
        {
          fetchImpl: streamedFetch as unknown as typeof fetch,
          dnsLookup: publicDns,
          limits: { maxResponseBytes: 10 },
        },
      ),
    ).rejects.toMatchObject({ code: "SOURCE_TOO_LARGE" });
  });

  it("enforces one deadline across DNS, redirects, fetch, and body reading", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        });
      }),
    );
    const request = buildSourceContext(
      { sourceUrl: "https://public.example/slow" },
      {
        fetchImpl: fetchMock as unknown as typeof fetch,
        dnsLookup: publicDns,
        limits: { timeoutMs: 25 },
      },
    );
    const expectation = expect(request).rejects.toMatchObject({ code: "SOURCE_FETCH_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(26);
    await expectation;
  });

  it("rejects binary media and does not log source content", async () => {
    const logSpies = [
      vi.spyOn(console, "log").mockImplementation(() => undefined),
      vi.spyOn(console, "warn").mockImplementation(() => undefined),
      vi.spyOn(console, "error").mockImplementation(() => undefined),
      vi.spyOn(console, "debug").mockImplementation(() => undefined),
    ];
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("sensitive-source-content", {
        headers: { "Content-Type": "application/pdf" },
      }),
    );
    await expect(
      buildSourceContext(
        { sourceUrl: "https://public.example/file.pdf" },
        { fetchImpl: fetchMock as unknown as typeof fetch, dnsLookup: publicDns },
      ),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_SOURCE_TYPE" });
    for (const spy of logSpies) expect(spy).not.toHaveBeenCalled();
  });

  it("normalizes and caps each textual snapshot field deterministically", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      response(`<article><h1>Long title here</h1><p>${"甲".repeat(80)}</p></article>`),
    );
    const result = await buildSourceContext(
      { sourceUrl: "https://public.example/long", draftText: "乙".repeat(40) },
      {
        fetchImpl: fetchMock as unknown as typeof fetch,
        dnsLookup: publicDns,
        limits: { maxDraftChars: 10, maxTitleChars: 8, maxArticleChars: 20 },
      },
    );
    expect(result.title).toBe("Long tit");
    expect(result.articleText).toBe("甲".repeat(20));
    expect(result.combinedFactualText).toContain("乙".repeat(10));
    expect(result.combinedFactualText).not.toContain("乙".repeat(11));
  });
});
