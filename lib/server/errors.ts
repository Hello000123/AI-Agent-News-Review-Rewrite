export class AppError extends Error {
  constructor(
    public readonly code: string,
    public readonly publicMessage: string,
    public readonly status: number,
    options?: ErrorOptions,
  ) {
    super(publicMessage, options);
    this.name = "AppError";
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
