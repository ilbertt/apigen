export enum HttpStatus {
  Ok = 200,
  Created = 201,
  NoContent = 204,
  BadRequest = 400,
  Forbidden = 403,
  NotFound = 404,
  MethodNotAllowed = 405,
  InternalServerError = 500,
}

/** A failure with an HTTP status; the handler turns it into a JSON error Response. */
export class ApiError extends Error {
  readonly status: number;

  constructor({ status, message }: { status: number; message: string }) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export function jsonResponse({ status, body }: { status: number; body: unknown }): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
