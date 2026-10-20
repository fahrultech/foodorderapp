import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { AppException } from './app-exception';
import { codeForStatus, ErrorFormatFilter } from './error-format.filter';

/** Minimal ArgumentsHost recording status()/json() from the response. */
function mockHost(): { host: any; status: jest.Mock; json: jest.Mock } {
  const status = jest.fn().mockReturnThis();
  const json = jest.fn().mockReturnThis();
  const res = { status, json };
  const host = { switchToHttp: () => ({ getResponse: () => res }) };
  return { host, status, json };
}

function catchEnvelope(exception: unknown): { status: number; body: any } {
  const filter = new ErrorFormatFilter();
  const { host, status, json } = mockHost();
  filter.catch(exception, host);
  expect(status).toHaveBeenCalledTimes(1);
  expect(json).toHaveBeenCalledTimes(1);
  return { status: status.mock.calls[0][0], body: json.mock.calls[0][0] };
}

describe('codeForStatus', () => {
  it('maps the statuses the app actually emits', () => {
    expect(codeForStatus(400)).toBe('BAD_REQUEST');
    expect(codeForStatus(401)).toBe('UNAUTHORIZED');
    expect(codeForStatus(403)).toBe('FORBIDDEN');
    expect(codeForStatus(404)).toBe('NOT_FOUND');
    expect(codeForStatus(409)).toBe('CONFLICT');
    expect(codeForStatus(422)).toBe('UNPROCESSABLE_ENTITY');
    expect(codeForStatus(429)).toBe('TOO_MANY_REQUESTS');
    expect(codeForStatus(500)).toBe('INTERNAL_SERVER_ERROR');
    expect(codeForStatus(503)).toBe('SERVICE_UNAVAILABLE');
  });

  it('falls back to HTTP_<status> for unlisted codes', () => {
    expect(codeForStatus(418)).toBe('HTTP_418');
    expect(codeForStatus(451)).toBe('HTTP_451');
  });
});

describe('ErrorFormatFilter — envelope shape', () => {
  it('wraps every common HttpException into { error: { code, message, details } }', () => {
    const cases: Array<[HttpException, number, string, string]> = [
      [new BadRequestException('Invalid quantity for item'), 400, 'BAD_REQUEST', 'Invalid quantity for item'],
      [new UnauthorizedException('Missing bearer token'), 401, 'UNAUTHORIZED', 'Missing bearer token'],
      [new ForbiddenException('You do not own this restaurant'), 403, 'FORBIDDEN', 'You do not own this restaurant'],
      [new NotFoundException('Order not found'), 404, 'NOT_FOUND', 'Order not found'],
      [new ConflictException('Email already registered'), 409, 'CONFLICT', 'Email already registered'],
    ];
    for (const [exc, status, code, message] of cases) {
      const { status: got, body } = catchEnvelope(exc);
      expect(got).toBe(status);
      expect(body).toEqual({ error: { code, message, details: null } });
    }
  });

  it('keeps details:null as an always-present key (stable contract)', () => {
    const { body } = catchEnvelope(new NotFoundException('Restaurant not found'));
    expect(Object.keys(body.error)).toEqual(['code', 'message', 'details']);
    expect(body.error.details).toBeNull();
  });

  it('renders ValidationPipe failures: message → details, generic headline', () => {
    const validationBody = {
      statusCode: 400,
      error: 'Bad Request',
      message: ['name must be a string', 'property userId should not exist'],
    };
    const { status, body } = catchEnvelope(new BadRequestException(validationBody as any));
    expect(status).toBe(400);
    expect(body).toEqual({
      error: {
        code: 'BAD_REQUEST',
        message: 'Validation failed',
        details: ['name must be a string', 'property userId should not exist'],
      },
    });
  });

  it('AppException passes its explicit code and details through', () => {
    const exc = new AppException(HttpStatus.BAD_REQUEST, 'MIN_ORDER_NOT_MET', 'Order is below the minimum', {
      minimumCents: 2000,
      subtotalCents: 1500,
    });
    const { status, body } = catchEnvelope(exc);
    expect(status).toBe(400);
    expect(body).toEqual({
      error: {
        code: 'MIN_ORDER_NOT_MET',
        message: 'Order is below the minimum',
        details: { minimumCents: 2000, subtotalCents: 1500 },
      },
    });
  });

  it('accepts array details on AppException too', () => {
    const exc = new AppException(HttpStatus.UNPROCESSABLE_ENTITY, 'CART_STALE', 'Some items changed', ['a', 'b']);
    const { status, body } = catchEnvelope(exc);
    expect(status).toBe(422);
    expect(body.error.code).toBe('CART_STALE');
    expect(body.error.details).toEqual(['a', 'b']);
  });

  it('non-HttpExceptions become a sanitized 500 — internals never reach the client', () => {
    const boom = new Error('duplicate key value violates unique constraint "users_email_key" (pg 23505)');
    const { status, body } = catchEnvelope(boom);
    expect(status).toBe(500);
    expect(body).toEqual({
      error: { code: 'INTERNAL_SERVER_ERROR', message: 'Internal server error', details: null },
    });
    expect(JSON.stringify(body)).not.toMatch(/pg|constraint|users_email/);
  });

  it('string-body custom statuses keep their message and get HTTP_<status>', () => {
    const { status, body } = catchEnvelope(new HttpException('I like tea', 418));
    expect(status).toBe(418);
    expect(body).toEqual({ error: { code: 'HTTP_418', message: 'I like tea', details: null } });
  });

  it('object bodies without a usable message fall back to status text', () => {
    const { status, body } = catchEnvelope(new HttpException({}, HttpStatus.SERVICE_UNAVAILABLE));
    expect(status).toBe(503);
    expect(body.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(body.error.message).toBe('Service Unavailable');
  });

  it('coerces non-object details to null instead of emitting invalid JSON shapes', () => {
    const fakeAppExc = new HttpException(
      { code: 'WEIRD', message: 'has junk details', details: 'nope' },
      HttpStatus.BAD_REQUEST,
    );
    const { body } = catchEnvelope(fakeAppExc);
    expect(body.error.code).toBe('WEIRD');
    expect(body.error.details).toBeNull();
  });

  it('preserves the HTTP status of explicit-code exceptions (code never rewrites status)', () => {
    const exc = new AppException(HttpStatus.FORBIDDEN, 'ROLE_REQUIRED', 'Owner role needed');
    const { status, body } = catchEnvelope(exc);
    expect(status).toBe(403);
    expect(body.error.code).toBe('ROLE_REQUIRED');
  });
});
