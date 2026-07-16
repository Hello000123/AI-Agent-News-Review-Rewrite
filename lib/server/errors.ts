import type { QuotationIssue } from "@/lib/shared/contracts";

export interface PublicErrorDetails {
  details?: string[];
  retryable?: boolean;
  stage?: "review_request" | "rewrite_request";
  provider?: string;
  model?: string;
  httpStatus?: number;
  causeSummary?: string;
  quotationIssues?: QuotationIssue[];
  candidateText?: string;
  attempts?: number;
}

interface AppErrorOptions extends ErrorOptions {
  publicDetails?: PublicErrorDetails;
}

export class AppError extends Error {
  public readonly publicDetails?: PublicErrorDetails;

  constructor(
    public readonly code: string,
    public readonly publicMessage: string,
    public readonly status: number,
    options?: AppErrorOptions,
  ) {
    super(publicMessage, options);
    this.name = "AppError";
    this.publicDetails = options?.publicDetails;
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
