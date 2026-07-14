import { createServer } from "node:http";

const port = Number(process.env.MOCK_DEEPSEEK_PORT || 4010);

const lowReview = {
  overallScore: 46,
  contentScore: 50,
  writingScore: 38,
  structureScore: 41,
  toneScore: 53,
  clarityScore: 44,
  scoreReasons: {
    content: "The central announcement lacks essential supporting facts.",
    clarity: "Fragments and repetition obscure the intended meaning.",
    structure: "The draft lacks a clear lead and logical order.",
    tone: "The wording is too informal for a professional news report.",
    writing: "Grammar and punctuation errors require correction.",
  },
  decision: "REWRITE_REQUIRED",
  strengths: ["The central announcement can be identified."],
  problems: [
    "The opening does not clearly state the news.",
    "Sentence fragments and repetition reduce readability.",
  ],
  missingInformation: [
    "[Content - moderate] The responsible organisation and timing are not identified.",
  ],
  recommendations: [
    "Lead with the announcement.",
    "Use complete sentences and a professional news-report structure.",
  ],
};

const highReview = {
  overallScore: 92,
  contentScore: 93,
  writingScore: 91,
  structureScore: 92,
  toneScore: 94,
  clarityScore: 90,
  scoreReasons: {
    content: "The announcement is complete, specific, and internally consistent.",
    clarity: "The draft communicates its meaning precisely and efficiently.",
    structure: "The lead and supporting details follow a professional order.",
    tone: "The language is factual, credible, and professional.",
    writing: "Grammar, spelling, punctuation, and mechanics are polished.",
  },
  decision: "PASS",
  strengths: [
    "The announcement is prominent and specific.",
    "The draft uses a professional structure and tone.",
  ],
  problems: [],
  missingInformation: [],
  recommendations: ["Perform a final fact check before distribution."],
};

let reviewCalls = 0;
let rewriteCalls = 0;

function sendJson(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(body));
}

function completion(content, finishReason = "stop") {
  return {
    id: "mock-completion",
    choices: [
      {
        index: 0,
        finish_reason: finishReason,
        message: { role: "assistant", content },
      },
    ],
    model: "mock-deepseek-v4-flash",
  };
}

const server = createServer((request, response) => {
  if (request.method !== "POST" || request.url !== "/chat/completions") {
    sendJson(response, 404, { error: { message: "Not found" } });
    return;
  }

  let rawBody = "";
  request.setEncoding("utf8");
  request.on("data", (chunk) => {
    rawBody += chunk;
    if (rawBody.length > 1_000_000) request.destroy();
  });
  request.on("end", () => {
    let body;
    try {
      body = JSON.parse(rawBody);
    } catch {
      sendJson(response, 400, { error: { message: "Invalid JSON" } });
      return;
    }

    const userContent =
      body.messages?.find((message) => message.role === "user")?.content || "";

    if (userContent.includes("SIMULATE_AUTH_FAILURE")) {
      sendJson(response, 401, { error: { message: "Mock invalid key" } });
      return;
    }

    if (userContent.includes("SIMULATE_TIMEOUT")) {
      setTimeout(() => {
        if (!response.writableEnded) sendJson(response, 200, completion(JSON.stringify(lowReview)));
      }, 2_500);
      return;
    }

    if (body.response_format?.type === "json_object") {
      reviewCalls += 1;
      process.stdout.write(`Mock Review Agent call ${reviewCalls}\n`);
      const content = userContent.includes("SIMULATE_MALFORMED_REVIEW")
        ? "{invalid json"
        : JSON.stringify(userContent.includes("SIMULATE_PASS_REVIEW") ? highReview : lowReview);
      sendJson(response, 200, completion(content));
      return;
    }

    rewriteCalls += 1;
    process.stdout.write(`Mock Rewrite Agent call ${rewriteCalls}\n`);
    if (userContent.includes("SIMULATE_REWRITE_FAILURE")) {
      sendJson(response, 500, { error: { message: "Mock rewrite failure" } });
      return;
    }

    const payloadStart = userContent.lastIndexOf("\n\n{");
    let payload;
    try {
      payload = JSON.parse(userContent.slice(payloadStart + 2));
    } catch {
      sendJson(response, 400, { error: { message: "Mock rewrite payload was invalid" } });
      return;
    }
    const originalDraft = String(payload.originalDraft ?? "").trim();
    const requiredLanguage = String(payload.requiredOutputLanguage ?? "");
    const headline = requiredLanguage.startsWith("Traditional Chinese")
      ? "經審閱草稿的新聞報道"
      : requiredLanguage.startsWith("Simplified Chinese")
        ? "经审阅草稿改写的新闻报道"
        : "News report based on the reviewed draft";
    const rewrittenReport = [headline, "", originalDraft].join("\n");
    sendJson(response, 200, completion(rewrittenReport));
  });
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write("Mock DeepSeek server listening on http://127.0.0.1:" + port + "\n");
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
