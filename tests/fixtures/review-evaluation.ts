import type {
  EditorialInput,
  ReadinessBand,
  ReviewCategoryScores,
  ReviewResult,
} from "@/lib/shared/contracts";

export const ORIENTAL_DSE_ARTICLE_URL =
  "https://orientaldaily.on.cc/content/%E8%A6%81%E8%81%9E%E6%B8%AF%E8%81%9E/odn-20260716-0716_00174_001/DSE%E8%AA%9524%E7%8B%80%E5%85%83%E5%89%B5%E6%AD%B7%E5%8F%B2-20%E4%BA%BA%E7%95%99%E6%B8%AF%E8%AE%80%E9%86%AB";

export const EVALUATION_REVIEW_SCORE_WEIGHTS = {
  factualCompletenessScore: 0.25,
  structureScore: 0.2,
  clarityScore: 0.15,
  languageQualityScore: 0.15,
  professionalismScore: 0.15,
  attributionScore: 0.1,
} as const satisfies Record<keyof ReviewCategoryScores, number>;

export const REVIEW_EVALUATION_REQUEST_PARAMETERS = {
  model: "deepseek-v4-pro",
  thinking: "enabled",
  reasoningEffort: "max",
  temperature: "not_sent_in_thinking_mode",
  maxTokens: 64_000,
  stream: true,
} as const;

export type ReviewEvaluationLanguage = "english" | "traditional_chinese";
export type ReviewScoreKey = keyof typeof EVALUATION_REVIEW_SCORE_WEIGHTS;
export type ReadinessRiskKey = keyof ReviewResult["readinessRisks"];

export interface ReviewEvaluationExpectations {
  readonly readinessBand: ReadinessBand;
  readonly allowedReadinessBands?: readonly ReadinessBand[];
  readonly overallScoreRange: readonly [minimum: number, maximum: number];
  readonly maximumOverallRunSpread: number;
  readonly maximumCategoryRunSpread: number;
  readonly minimumCategoryScores?: Partial<Record<ReviewScoreKey, number>>;
  readonly maximumCategoryScores?: Partial<Record<ReviewScoreKey, number>>;
  readonly requiredRisks?: Partial<Record<ReadinessRiskKey, boolean>>;
  readonly requireNoScoreCap?: boolean;
  readonly maximumAppliedScoreCap?: number;
  readonly minimumFindings?: number;
}

export interface ReviewEvaluationCase {
  readonly id: string;
  readonly language: ReviewEvaluationLanguage;
  readonly inputKind: "text" | "url" | "text_with_reference";
  readonly tags: readonly string[];
  readonly request: EditorialInput;
  readonly expected: ReviewEvaluationExpectations;
}

const noReadinessRisks = {
  severelyIncompleteOrUnreliable: false,
  seriousFactualGaps: false,
  unsupportedClaims: false,
  majorStructuralProblems: false,
  veryPoorLanguage: false,
  seriousAttributionOrQuotationProblems: false,
} as const;

const publicationReadyExpectations = {
  readinessBand: "PUBLICATION_READY",
  overallScoreRange: [90, 100],
  maximumOverallRunSpread: 8,
  maximumCategoryRunSpread: 12,
  minimumCategoryScores: {
    factualCompletenessScore: 75,
    structureScore: 75,
    clarityScore: 75,
    languageQualityScore: 75,
    professionalismScore: 75,
    attributionScore: 75,
  },
  requiredRisks: noReadinessRisks,
  requireNoScoreCap: true,
} as const satisfies ReviewEvaluationExpectations;

const strongLimitedEditingExpectations = {
  readinessBand: "STRONG_LIMITED_EDITING",
  overallScoreRange: [75, 89],
  maximumOverallRunSpread: 8,
  maximumCategoryRunSpread: 12,
  minimumCategoryScores: {
    factualCompletenessScore: 65,
    structureScore: 65,
    clarityScore: 65,
    languageQualityScore: 65,
    professionalismScore: 65,
    attributionScore: 65,
  },
  requiredRisks: noReadinessRisks,
} as const satisfies ReviewEvaluationExpectations;

const highQualityExpectations = {
  readinessBand: "STRONG_LIMITED_EDITING",
  allowedReadinessBands: ["STRONG_LIMITED_EDITING", "PUBLICATION_READY"],
  overallScoreRange: [75, 100],
  maximumOverallRunSpread: 8,
  maximumCategoryRunSpread: 12,
  minimumCategoryScores: {
    factualCompletenessScore: 75,
    structureScore: 75,
    clarityScore: 75,
    languageQualityScore: 75,
    professionalismScore: 75,
    attributionScore: 75,
  },
  requiredRisks: noReadinessRisks,
} as const satisfies ReviewEvaluationExpectations;

function textRequest(draft: string): EditorialInput {
  return { draft, sourceUrl: "" };
}

const traditionalPoorDraft =
  "運輸署今日話81K同87D線會由8月1日起在繁忙時段加班，早上7時至9時由每15分鐘一班改為每10分鐘一班，安排先試4星期。呢段寫得有啲亂，總之係加車，前面講咗日期後面又再講8月1日，乘客應該會等少啲。運輸署話4星期後再睇乘客量同候車時間數據。";

const publisherReferencePoorDraft =
  "DSE可能今日放榜？狀元人數有人話24、有人話42，未核實。20人定2人留港讀醫都唔肯定。呢啲只係亂記，學校、消息來源同日期全部未查，唔可以刊登。";

export const reviewEvaluationCases: readonly ReviewEvaluationCase[] = [
  {
    id: "oriental_dse_2026_live_url",
    language: "traditional_chinese",
    inputKind: "url",
    tags: ["traditional_chinese", "high_quality", "live_url", "publisher_independence"],
    request: {
      draft: "",
      sourceUrl: ORIENTAL_DSE_ARTICLE_URL,
    },
    expected: strongLimitedEditingExpectations,
  },
  {
    id: "traditional_high_quality",
    language: "traditional_chinese",
    inputKind: "text",
    tags: ["traditional_chinese", "high_quality", "complete_facts", "attribution"],
    request: textRequest(
      [
        "運輸署公布三條巴士線8月起繁忙時段加班",
        "運輸署周四公布，三條專營巴士路線將於8月1日起在繁忙時段增加班次，合共調配18輛巴士，以縮短新界東乘客的候車時間。",
        "署方表示，新安排涵蓋81K、87D及299X線，平日早上7時至9時的班次將由每12至15分鐘一班，縮短至每8至10分鐘一班。調整是根據今年首六個月的乘客量及候車時間數據制定。",
        "運輸署發言人說：「署方會在措施實施後四星期檢視乘客量及實際候車時間，再決定是否需要進一步調整。」三間巴士公司已確認車輛及車長安排，不會因加班而削減其他路線的既定班次。",
      ].join("\n\n"),
    ),
    expected: highQualityExpectations,
  },
  {
    id: "traditional_poor_draft",
    language: "traditional_chinese",
    inputKind: "text",
    tags: ["traditional_chinese", "poor_draft", "disorganised", "poor_language"],
    request: textRequest(traditionalPoorDraft),
    expected: {
      readinessBand: "WEAK",
      overallScoreRange: [40, 59],
      maximumOverallRunSpread: 8,
      maximumCategoryRunSpread: 12,
      maximumCategoryScores: { structureScore: 59, professionalismScore: 59 },
      maximumAppliedScoreCap: 59,
      minimumFindings: 1,
    },
  },
  {
    id: "traditional_poor_draft_with_publisher_reference",
    language: "traditional_chinese",
    inputKind: "text_with_reference",
    tags: [
      "traditional_chinese",
      "poor_draft",
      "publisher_independence",
      "live_url",
    ],
    request: {
      draft: publisherReferencePoorDraft,
      sourceUrl: ORIENTAL_DSE_ARTICLE_URL,
    },
    expected: {
      readinessBand: "SEVERELY_DEFICIENT",
      overallScoreRange: [0, 39],
      maximumOverallRunSpread: 8,
      maximumCategoryRunSpread: 12,
      maximumCategoryScores: { structureScore: 39, professionalismScore: 39 },
      requiredRisks: {
        severelyIncompleteOrUnreliable: true,
        majorStructuralProblems: true,
      },
      maximumAppliedScoreCap: 39,
      minimumFindings: 1,
    },
  },
  {
    id: "english_high_quality",
    language: "english",
    inputKind: "text",
    tags: ["english", "high_quality", "complete_facts", "attribution"],
    request: textRequest(
      [
        "Riverton approves $6.4 million flood-control programme",
        "Riverton Council approved a $6.4 million flood-control programme on 14 July 2026, authorising drainage upgrades at four locations that flooded repeatedly last winter.",
        "Construction is scheduled to begin on 3 August and finish by 30 November. The council said the contract covers new pumps, enlarged drains and water-level sensors, and will be funded from its existing resilience budget.",
        "Council engineer Maya Chen said, “The work targets the four locations with the longest recorded road closures last winter.” The transport department will publish temporary traffic arrangements at least seven days before work begins at each site.",
      ].join("\n\n"),
    ),
    expected: publicationReadyExpectations,
  },
  {
    id: "english_poor_draft",
    language: "english",
    inputKind: "text",
    tags: ["english", "poor_draft", "disorganised", "poor_language"],
    request: textRequest(
      "City Transit approved a fare increase on 14 July 2026. Adult fares go from $2.40 to $2.60 on 1 September, while student fares stay $1.20. This draft is messy, say the price later maybe, but anyway fuel and staff costs rose 8% last year. The company said no routes will be cut. Put that good bit first? Then repeat: fares become $2.60 on 1 September. The transport regulator approved the change after a public consultation.",
    ),
    expected: {
      readinessBand: "WEAK",
      overallScoreRange: [40, 59],
      maximumOverallRunSpread: 8,
      maximumCategoryRunSpread: 12,
      maximumCategoryScores: { structureScore: 59, professionalismScore: 59 },
      maximumAppliedScoreCap: 59,
      minimumFindings: 1,
    },
  },
  {
    id: "missing_core_facts",
    language: "english",
    inputKind: "text",
    tags: ["english", "missing_facts", "incomplete", "named_source"],
    request: textRequest(
      "Riverton Council said on 14 July 2026 that it will open a learning centre offering evening technology courses. The announcement did not identify the centre's location, opening date, capacity, fees or course operator.",
    ),
    expected: {
      readinessBand: "WEAK",
      overallScoreRange: [40, 59],
      maximumOverallRunSpread: 8,
      maximumCategoryRunSpread: 12,
      maximumCategoryScores: { factualCompletenessScore: 59 },
      requiredRisks: { seriousFactualGaps: true },
      maximumAppliedScoreCap: 59,
      minimumFindings: 1,
    },
  },
  {
    id: "unsupported_material_claims",
    language: "english",
    inputKind: "text",
    tags: ["english", "unsupported_claims", "statistics", "promotional_language"],
    request: textRequest(
      "Harbour Analytics launched a traffic platform on Tuesday. The company said the platform will eliminate congestion across the city within six months, cut every commuter's journey by exactly 37% and is the safest transport system ever developed. The article provides no study, trial results, methodology, independent source or qualification for those claims.",
    ),
    expected: {
      readinessBand: "WEAK",
      overallScoreRange: [40, 59],
      maximumOverallRunSpread: 8,
      // The final readiness result is cap-stable; allow modest variation among
      // secondary categories while keeping the factual/professional gates strict.
      maximumCategoryRunSpread: 15,
      maximumCategoryScores: { factualCompletenessScore: 59, professionalismScore: 59 },
      requiredRisks: { unsupportedClaims: true },
      maximumAppliedScoreCap: 59,
      minimumFindings: 1,
    },
  },
  {
    id: "severely_unreliable_fragment",
    language: "english",
    inputKind: "text",
    tags: ["english", "severely_deficient", "unsupported_claims", "contradictory"],
    request: textRequest(
      "Amazing transport thing fixed every road problem. It launched recently—or maybe it has not launched yet; confirm later. Everyone approves and there have been zero accidents. Add the operator, product, city, date, evidence and sources.",
    ),
    expected: {
      readinessBand: "SEVERELY_DEFICIENT",
      overallScoreRange: [0, 39],
      maximumOverallRunSpread: 10,
      maximumCategoryRunSpread: 12,
      maximumCategoryScores: { factualCompletenessScore: 39, attributionScore: 39 },
      requiredRisks: {
        severelyIncompleteOrUnreliable: true,
        unsupportedClaims: true,
      },
      maximumAppliedScoreCap: 39,
      minimumFindings: 1,
    },
  },
  {
    id: "traditional_multiple_quotation_styles",
    language: "traditional_chinese",
    inputKind: "text",
    tags: [
      "traditional_chinese",
      "high_quality",
      "multiple_quotations",
      "chinese_punctuation",
      "attribution",
    ],
    request: textRequest(
      [
        "兩間地區康健中心8月起延長晚間服務",
        "衞生署7月16日公布，兩間地區康健中心將於8月起延長平日晚間服務，試行期為三個月，預計每周增加240個預約名額。",
        "衞生署署長陳慧儀說：「延長服務是回應在職居民的求診需要。」九龍東中心行政總監李文正表示：『中心會保留日間名額，不會把原有服務轉到晚上。』",
        "護士代表黃嘉敏說：“新增更次已完成編排，員工可按既定安排輪值。”病人組織召集人周樂怡表示：‘我們會收集使用者對預約流程的意見。’",
        "署方表示，試行期結束後會公布使用率、輪候時間及人手數據，再決定是否延續安排。",
      ].join("\n\n"),
    ),
    expected: {
      ...highQualityExpectations,
      minimumCategoryScores: {
        ...highQualityExpectations.minimumCategoryScores,
        attributionScore: 85,
      },
    },
  },
] as const;

export interface ReviewEvaluationComparison {
  readonly id: string;
  readonly higherCaseId: string;
  readonly lowerCaseId: string;
  readonly minimumMedianGap: number;
}

export const reviewEvaluationComparisons: readonly ReviewEvaluationComparison[] = [
  {
    id: "traditional_quality_separation",
    higherCaseId: "traditional_high_quality",
    lowerCaseId: "traditional_poor_draft",
    minimumMedianGap: 25,
  },
  {
    id: "english_quality_separation",
    higherCaseId: "english_high_quality",
    lowerCaseId: "english_poor_draft",
    minimumMedianGap: 25,
  },
] as const;

const scoreKeys = Object.keys(EVALUATION_REVIEW_SCORE_WEIGHTS) as ReviewScoreKey[];

export function calculateEvaluationWeightedScore(scores: ReviewCategoryScores) {
  return Math.round(
    scoreKeys.reduce(
      (total, key) => total + scores[key] * EVALUATION_REVIEW_SCORE_WEIGHTS[key],
      0,
    ),
  );
}

export function evaluationReadinessBandForScore(score: number): ReadinessBand {
  if (score >= 90) return "PUBLICATION_READY";
  if (score >= 75) return "STRONG_LIMITED_EDITING";
  if (score >= 60) return "SUBSTANTIAL_REWRITE";
  if (score >= 40) return "WEAK";
  return "SEVERELY_DEFICIENT";
}

function finiteScore(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
}

function categoryScores(review: ReviewResult): ReviewCategoryScores {
  return Object.fromEntries(scoreKeys.map((key) => [key, review[key]])) as ReviewCategoryScores;
}

export interface ReviewEvaluationResult {
  readonly passed: boolean;
  readonly failures: string[];
}

export function evaluateReviewResult(
  testCase: ReviewEvaluationCase,
  review: ReviewResult,
  passScore?: number,
): ReviewEvaluationResult {
  const failures: string[] = [];
  const { expected } = testCase;
  const [minimumOverall, maximumOverall] = expected.overallScoreRange;

  for (const key of scoreKeys) {
    if (!finiteScore(review[key])) failures.push(`${key} must be a finite score from 0 to 100.`);
  }
  if (!finiteScore(review.weightedScore)) {
    failures.push("weightedScore must be a finite score from 0 to 100.");
  }
  if (!finiteScore(review.overallScore)) {
    failures.push("overallScore must be a finite score from 0 to 100.");
  }

  if (scoreKeys.every((key) => finiteScore(review[key]))) {
    const recomputedWeighted = calculateEvaluationWeightedScore(categoryScores(review));
    if (review.weightedScore !== recomputedWeighted) {
      failures.push(
        `weightedScore ${review.weightedScore} does not match recomputed score ${recomputedWeighted}.`,
      );
    }
  }

  const expectedFinal = Math.min(review.weightedScore, review.appliedScoreCap ?? 100);
  if (review.overallScore !== expectedFinal) {
    failures.push(
      `overallScore ${review.overallScore} does not match weighted/capped score ${expectedFinal}.`,
    );
  }
  if (review.readinessBand !== evaluationReadinessBandForScore(review.overallScore)) {
    failures.push("readinessBand is inconsistent with overallScore.");
  }
  if (review.overallScore < minimumOverall || review.overallScore > maximumOverall) {
    failures.push(
      `overallScore ${review.overallScore} is outside expected range ${minimumOverall}-${maximumOverall}.`,
    );
  }
  const allowedReadinessBands = expected.allowedReadinessBands ?? [expected.readinessBand];
  if (!allowedReadinessBands.includes(review.readinessBand)) {
    failures.push(
      `readinessBand ${review.readinessBand} does not match expected ${allowedReadinessBands.join(" or ")}.`,
    );
  }

  if (review.appliedScoreCap === null && review.scoreCapReasons.length > 0) {
    failures.push("scoreCapReasons must be empty when no score cap was applied.");
  }
  if (review.appliedScoreCap !== null && review.scoreCapReasons.length === 0) {
    failures.push("An applied score cap must include at least one cap reason.");
  }
  if (expected.requireNoScoreCap && review.appliedScoreCap !== null) {
    failures.push(`Expected no score cap, but cap ${review.appliedScoreCap} was applied.`);
  }
  if (
    expected.maximumAppliedScoreCap !== undefined &&
    (review.appliedScoreCap === null ||
      review.appliedScoreCap > expected.maximumAppliedScoreCap)
  ) {
    failures.push(`Expected an applied score cap at or below ${expected.maximumAppliedScoreCap}.`);
  }

  for (const [key, minimum] of Object.entries(expected.minimumCategoryScores ?? {}) as Array<
    [ReviewScoreKey, number]
  >) {
    if (review[key] < minimum) failures.push(`${key} ${review[key]} is below expected minimum ${minimum}.`);
  }
  for (const [key, maximum] of Object.entries(expected.maximumCategoryScores ?? {}) as Array<
    [ReviewScoreKey, number]
  >) {
    if (review[key] > maximum) failures.push(`${key} ${review[key]} exceeds expected maximum ${maximum}.`);
  }
  for (const [key, required] of Object.entries(expected.requiredRisks ?? {}) as Array<
    [ReadinessRiskKey, boolean]
  >) {
    if (review.readinessRisks[key] !== required) {
      failures.push(`readinessRisks.${key} must be ${required}.`);
    }
  }
  if (review.findings.length < (expected.minimumFindings ?? 0)) {
    failures.push(`Expected at least ${expected.minimumFindings} structured finding(s).`);
  }

  if (passScore !== undefined) {
    const expectedDecision = review.overallScore >= passScore ? "PASS" : "REWRITE_REQUIRED";
    if (review.decision !== expectedDecision) {
      failures.push(`decision ${review.decision} is inconsistent with pass score ${passScore}.`);
    }
  }

  return { passed: failures.length === 0, failures };
}

function spread(values: readonly number[]) {
  return values.length > 0 ? Math.max(...values) - Math.min(...values) : null;
}

export interface ReviewRunsEvaluation extends ReviewEvaluationResult {
  readonly overallSpread: number | null;
  readonly categorySpreads: Readonly<Partial<Record<ReviewScoreKey, number>>>;
  readonly medianOverallScore: number | null;
}

export function median(values: readonly number[]) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

export function evaluateReviewRuns(
  testCase: ReviewEvaluationCase,
  reviews: readonly ReviewResult[],
  expectedRunCount = reviews.length,
  passScore?: number,
): ReviewRunsEvaluation {
  const failures: string[] = [];
  if (reviews.length !== expectedRunCount) {
    failures.push(`Received ${reviews.length} successful run(s); expected ${expectedRunCount}.`);
  }
  reviews.forEach((review, index) => {
    const result = evaluateReviewResult(testCase, review, passScore);
    failures.push(...result.failures.map((failure) => `Run ${index + 1}: ${failure}`));
  });

  const overallScores = reviews.map(({ overallScore }) => overallScore);
  const overallSpread = spread(overallScores);
  if (
    overallSpread !== null &&
    overallSpread > testCase.expected.maximumOverallRunSpread
  ) {
    failures.push(
      `Overall score spread ${overallSpread} exceeds ${testCase.expected.maximumOverallRunSpread}.`,
    );
  }

  const categorySpreads: Partial<Record<ReviewScoreKey, number>> = {};
  for (const key of scoreKeys) {
    const categorySpread = spread(reviews.map((review) => review[key]));
    if (categorySpread === null) continue;
    categorySpreads[key] = categorySpread;
    if (categorySpread > testCase.expected.maximumCategoryRunSpread) {
      failures.push(
        `${key} run spread ${categorySpread} exceeds ${testCase.expected.maximumCategoryRunSpread}.`,
      );
    }
  }

  return {
    passed: failures.length === 0,
    failures,
    overallSpread,
    categorySpreads,
    medianOverallScore: median(overallScores),
  };
}

export function evaluateReviewComparisons(
  medianScoresByCase: Readonly<Record<string, number | undefined>>,
  comparisons: readonly ReviewEvaluationComparison[] = reviewEvaluationComparisons,
): ReviewEvaluationResult {
  const failures: string[] = [];
  for (const comparison of comparisons) {
    const higher = medianScoresByCase[comparison.higherCaseId];
    const lower = medianScoresByCase[comparison.lowerCaseId];
    if (higher === undefined || lower === undefined) {
      failures.push(`${comparison.id}: comparison is missing one or both case medians.`);
      continue;
    }
    const gap = higher - lower;
    if (gap < comparison.minimumMedianGap) {
      failures.push(
        `${comparison.id}: median gap ${gap} is below ${comparison.minimumMedianGap}.`,
      );
    }
  }
  return { passed: failures.length === 0, failures };
}
