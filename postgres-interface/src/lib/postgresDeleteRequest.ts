import { PostgresRequestError } from './postgresErrors';

export interface ParsedDeleteConnectionRequest {
  connectionId: string | null;
}

const own = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const invalid = (): never => {
  throw new PostgresRequestError(400, 'Invalid PostgreSQL connection deletion request');
};

export function parseDeleteConnectionRequest(value: unknown): ParsedDeleteConnectionRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalid();
  const request = value as Record<string, unknown>;
  if (!own(request, 'action') || request.action !== 'delete-connection') return invalid();
  if (Object.keys(request).some((key) => key !== 'action' && key !== 'connection')) {
    return invalid();
  }
  if (!own(request, 'connection')) return { connectionId: null };
  if (typeof request.connection !== 'string' || request.connection.trim().length === 0) {
    return invalid();
  }
  return { connectionId: request.connection };
}
