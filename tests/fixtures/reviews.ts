import type { ReviewResult } from "@/lib/shared/contracts";

export const lowReview: ReviewResult = {
  overallScore: 44,
  contentScore: 48,
  writingScore: 36,
  structureScore: 38,
  toneScore: 51,
  clarityScore: 42,
  scoreReasons: {
    content: "The announcement is identifiable but lacks essential supporting detail.",
    clarity: "Fragments and repetition make the meaning difficult to follow.",
    structure: "The draft has no effective lead or logical paragraph order.",
    tone: "Informal wording is not suitable for a professional release.",
    writing: "Frequent sentence and punctuation errors require correction.",
  },
  decision: "PASS",
  strengths: ["The main announcement can be identified."],
  problems: ["The opening is fragmented and repetitive."],
  missingInformation: ["Publication date", "Company contact details"],
  recommendations: ["Lead with the announcement and add the missing details."],
};

export const highReview: ReviewResult = {
  overallScore: 91,
  contentScore: 92,
  writingScore: 90,
  structureScore: 91,
  toneScore: 93,
  clarityScore: 89,
  scoreReasons: {
    content: "The announcement and supporting facts are complete and internally consistent.",
    clarity: "The meaning is precise, with one sentence that could be shortened.",
    structure: "The lead and supporting paragraphs are ordered effectively.",
    tone: "The language is factual, credible, and professional.",
    writing: "Grammar, spelling, punctuation, and mechanics are polished.",
  },
  decision: "REWRITE_REQUIRED",
  strengths: ["The announcement is clear and well supported."],
  problems: [],
  missingInformation: [],
  recommendations: ["Perform a final fact check before distribution."],
};
