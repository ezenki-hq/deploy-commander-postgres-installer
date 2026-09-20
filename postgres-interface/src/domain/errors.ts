export type PostgresErrorStatus = 400 | 404 | 409 | 499 | 500;

export class PostgresRequestError extends Error {
  constructor(
    readonly status: PostgresErrorStatus,
    message: string,
  ) {
    super(message);
    this.name = 'PostgresRequestError';
  }
}

export function rpcStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' ? status : undefined;
}

export function safeErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof PostgresRequestError) return error.message;
  if (error instanceof Error && error.message.trim()) return error.message;
  return fallback;
}
