export enum HttpStatus {
  Ok = 200,
  Created = 201,
  NoContent = 204,
  PartialContent = 206,
  BadRequest = 400,
  Forbidden = 403,
  NotFound = 404,
  MethodNotAllowed = 405,
  NotAcceptable = 406,
  Conflict = 409,
  InternalServerError = 500,
}

/** PostgREST serves JSON with an explicit charset; we match it byte-for-byte. */
export const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

/**
 * PostgREST's error envelope. Field order mirrors PostgREST's wire output
 * (`code, details, hint, message`) so serialized errors match byte-for-byte.
 */
export interface ErrorBody {
  readonly code: string | null;
  readonly details: string | null;
  readonly hint: string | null;
  readonly message: string;
}

/** A failure with an HTTP status and the PostgREST error envelope fields. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly details: string | null;
  readonly hint: string | null;

  constructor({
    status,
    message,
    code,
    details,
    hint,
  }: {
    status: number;
    message: string;
    code?: string | null;
    details?: string | null;
    hint?: string | null;
  }) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code ?? null;
    this.details = details ?? null;
    this.hint = hint ?? null;
  }
}

/**
 * Build a Response from an already-serialized (or empty) body. `body` is written
 * verbatim — for success paths it is the JSON text Postgres rendered, so numeric
 * scale, timestamp format, and key order match PostgREST exactly. A nullish body
 * yields an empty response (no content-type), as PostgREST does for `return=minimal`.
 */
export function buildResponse({
  status,
  body,
  headers,
}: {
  status: number;
  body?: string | null;
  headers?: Record<string, string>;
}): Response {
  const merged = new Headers(headers);
  if (body != null && !merged.has('content-type')) {
    merged.set('content-type', JSON_CONTENT_TYPE);
  }
  return new Response(body ?? null, { status, headers: merged });
}

export function jsonError({ status, body }: { status: number; body: ErrorBody }): Response {
  return buildResponse({ status, body: JSON.stringify(body) });
}
