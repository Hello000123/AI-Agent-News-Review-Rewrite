import { createServer } from "node:http";

const port = Number(process.env.MOCK_DEEPSEEK_PORT || 4010);

const lowReview = {
  overallScore: 41,
  factualCompletenessScore: 52,
  structureScore: 35,
  clarityScore: 38,
  languageQualityScore: 32,
  professionalismScore: 36,
  attributionScore: 48,
  scoreReasons: {
    factualCompleteness: "The central announcement lacks essential supporting facts.",
    structure: "The draft lacks a clear lead and logical order.",
    clarity: "Fragments and repetition obscure the intended meaning.",
    languageQuality: "Grammar and punctuation errors require correction.",
    professionalism: "The wording is too informal for a professional news report.",
    attribution: "Several claims are not tied clearly to an identified source.",
  },
  readinessRisks: {
    severelyIncompleteOrUnreliable: false,
    seriousFactualGaps: false,
    unsupportedClaims: false,
    majorStructuralProblems: true,
    veryPoorLanguage: true,
    seriousAttributionOrQuotationProblems: false,
  },
  findings: [
    {
      category: "structure",
      severity: "major",
      issue: "The copy lacks a usable news lead and coherent paragraph sequence.",
      evidence: "The opening consists of fragments and later paragraphs repeat the announcement.",
      recommendation: "Lead with the verified announcement and reorder supporting facts.",
    },
    {
      category: "languageQuality",
      severity: "major",
      issue: "Sentence construction and mechanics are below publication standard.",
      evidence: "Fragments and punctuation errors interrupt comprehension.",
      recommendation: "Rewrite complete sentences and perform a full language edit.",
    },
  ],
  decision: "REWRITE_REQUIRED",
  strengths: ["The central announcement can be identified."],
  missingInformation: ["The responsible organisation and timing are not identified."],
  recommendations: ["Lead with the announcement and rebuild the copy in a clear news order."],
};

const highReview = {
  overallScore: 91,
  factualCompletenessScore: 91,
  structureScore: 91,
  clarityScore: 91,
  languageQualityScore: 91,
  professionalismScore: 91,
  attributionScore: 91,
  scoreReasons: {
    factualCompleteness: "The event and supporting facts are complete and internally consistent.",
    structure: "The lead and supporting details follow a professional order.",
    clarity: "The draft communicates its meaning precisely and efficiently.",
    languageQuality: "Grammar, spelling, punctuation, and mechanics are polished.",
    professionalism: "The language is factual, credible, and professional.",
    attribution: "Claims and quotations are attributed clearly and consistently.",
  },
  readinessRisks: {
    severelyIncompleteOrUnreliable: false,
    seriousFactualGaps: false,
    unsupportedClaims: false,
    majorStructuralProblems: false,
    veryPoorLanguage: false,
    seriousAttributionOrQuotationProblems: false,
  },
  findings: [],
  decision: "PASS",
  strengths: [
    "The announcement is prominent and specific.",
    "The draft uses a professional structure and tone.",
  ],
  missingInformation: [],
  recommendations: ["[Optional - no score effect] Perform a final fact check before publication."],
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
        message: {
          role: "assistant",
          content,
          reasoning_content: "PRIVATE_MOCK_REASONING_NOT_FOR_CLIENTS",
        },
      },
    ],
    model: "deepseek-v4-pro",
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

    if (!["deepseek-v4-pro", "deepseek-v4-flash"].includes(body.model)) {
      sendJson(response, 400, {
        error: {
          message: `The supported API model names are deepseek-v4-pro or deepseek-v4-flash, but you passed ${String(body.model)}.`,
          type: "invalid_request_error",
          code: "invalid_request_error",
        },
      });
      return;
    }
    if (body.thinking?.type !== "enabled" || body.reasoning_effort !== "max") {
      sendJson(response, 400, {
        error: {
          message: "Mock requires thinking.enabled and reasoning_effort=max.",
          type: "invalid_request_error",
          code: "invalid_request_error",
        },
      });
      return;
    }

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
    const originalDraft = String(payload.source?.primaryText ?? "").trim();
    const requiredLanguage = String(payload.requiredOutputLanguage ?? "");
    const headline = requiredLanguage.startsWith("Traditional Chinese")
      ? "經審閱整理的新聞報道"
      : requiredLanguage.startsWith("Simplified Chinese")
        ? "经审阅整理的新闻报道"
        : "News report based on the reviewed draft";
    const bodyPrefix = requiredLanguage.startsWith("Traditional Chinese")
      ? "經編輯報道："
      : requiredLanguage.startsWith("Simplified Chinese")
        ? "经编辑报道："
        : "Edited news report: ";
    const rewrittenReport = [headline, "", bodyPrefix + originalDraft].join("\n");
    sendJson(response, 200, completion(rewrittenReport));
  });
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write("Mock DeepSeek server listening on http://127.0.0.1:" + port + "\n");
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
