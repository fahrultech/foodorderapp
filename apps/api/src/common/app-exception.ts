import { HttpException, HttpStatus } from '@nestjs/common';

/** Optional machine-readable payload that rides along in the error envelope. */
export type ErrorDetails = Record<string, unknown> | unknown[] | null;

/**
 * Domain exception with an explicit stable `code` and optional `details`.
 *
 * The global `ErrorFormatFilter` renders every failure as
 * `{ error: { code, message, details } }`. Plain `HttpException`s get a
 * status-derived code (`NotFoundException` → NOT_FOUND, ...); throw this
 * class when a consumer needs a more specific machine code than the HTTP
 * status conveys (e.g. MIN_ORDER_NOT_MET under a generic 400).
 */
export class AppException extends HttpException {
  constructor(
    status: HttpStatus,
    readonly code: string,
    message: string,
    readonly details: ErrorDetails = null,
  ) {
    super({ code, message, details }, status);
  }

  static conflict(code: string, message: string, details: ErrorDetails = null): AppException {
    return new AppException(HttpStatus.CONFLICT, code, message, details);
  }

  static badRequest(code: string, message: string, details: ErrorDetails = null): AppException {
    return new AppException(HttpStatus.BAD_REQUEST, code, message, details);
  }
}
