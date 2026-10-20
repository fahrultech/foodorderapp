import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import type { ErrorDetails } from './app-exception';

/**
 * Stable machine codes per HTTP status. Codes never change meaning even if
 * the transport status is remapped later — clients switch on `code`,
 * humans read `message`.
 */
const CODE_BY_STATUS: Record<number, string> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  422: 'UNPROCESSABLE_ENTITY',
  429: 'TOO_MANY_REQUESTS',
  500: 'INTERNAL_SERVER_ERROR',
  502: 'BAD_GATEWAY',
  503: 'SERVICE_UNAVAILABLE',
  504: 'GATEWAY_TIMEOUT',
};

export function codeForStatus(status: number): string {
  return CODE_BY_STATUS[status] ?? `HTTP_${status}`;
}

/** Canonical reason phrases (Nest 11 dropped HttpException.getStatusText). */
const TEXT_BY_STATUS: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  413: 'Payload Too Large',
  418: "I'm a Teapot",
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
};

interface Envelope {
  status: number;
  code: string;
  message: string;
  details: ErrorDetails;
}

/** Coerce anything a caller stuffed into `details` into a safe JSON shape. */
function normalizeDetails(value: unknown): ErrorDetails {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return value as Record<string, unknown>;
  return null;
}

/**
 * Catches every exception leaving the request pipeline (guards, pipes,
 * controllers, the router's own 404) and answers with exactly one shape:
 *
 *   { "error": { "code": "NOT_FOUND", "message": "Order not found", "details": null } }
 *
 * - ValidationPipe failures (message arrives as a string[]) keep every
 *   constraint in `details` with a generic top-level message.
 * - `AppException` (response object carrying string `code` + `message`)
 *   passes through untouched — explicit codes win over status-derived ones.
 * - Non-HttpExceptions are 500-sanitized: internals (driver errors, stacks)
 *   go to the server log only, never to the client.
 * The HTTP status itself is always preserved.
 */
@Catch()
export class ErrorFormatFilter implements ExceptionFilter {
  private readonly logger = new Logger(ErrorFormatFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const envelope = this.toEnvelope(exception);
    const res = host.switchToHttp().getResponse<Response>();
    res
      .status(envelope.status)
      .json({ error: { code: envelope.code, message: envelope.message, details: envelope.details } });
  }

  private toEnvelope(exception: unknown): Envelope {
    if (!(exception instanceof HttpException)) {
      // Unexpected failure: log the truth, answer a sanitized 500.
      const err = exception as Error;
      this.logger.error(
        `Unhandled exception: ${err?.message ?? String(exception)}`,
        err?.stack,
      );
      return {
        status: 500,
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Internal server error',
        details: null,
      };
    }

    const status = exception.getStatus();
    const body = exception.getResponse();

    if (typeof body === 'object' && body !== null) {
      const b = body as Record<string, unknown>;
      // AppException / explicit {code, message} object — pass through.
      if (typeof b.code === 'string' && typeof b.message === 'string') {
        return { status, code: b.code, message: b.message, details: normalizeDetails(b.details) };
      }
      // ValidationPipe / class-validator failures: string[] of constraints.
      if (Array.isArray(b.message)) {
        return {
          status,
          code: codeForStatus(status),
          message: 'Validation failed',
          details: b.message.map(String),
        };
      }
      if (typeof b.message === 'string') {
        return { status, code: codeForStatus(status), message: b.message, details: null };
      }
    }

    if (typeof body === 'string' && body.length > 0) {
      return { status, code: codeForStatus(status), message: body, details: null };
    }

    // Object without a usable message (e.g. `new HttpException({}, 503)`)
    // — fall back to the canonical status text.
    return {
      status,
      code: codeForStatus(status),
      message: TEXT_BY_STATUS[status] ?? 'Request failed',
      details: null,
    };
  }
}
