import { LoggerService } from '@nestjs/common';
import pino, { type Logger as PinoInstance } from 'pino';
import { currentReqId } from './request-context';

const SERVICE_NAME = 'foodorder-api';
const VALID_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;

export interface RootLoggerOverrides {
  level?: string;
  /** Destination stream; defaults to stdout. Tests capture into memory here. */
  stream?: Parameters<typeof pino>[1];
}

/**
 * One pino root instance for the whole process. Output is one JSON line per
 * event on stdout (container log collectors own shipping/rotation); the
 * level is tunable per deployment with LOG_LEVEL (default `info`).
 * `service` rides on every line for multi-service log streams; secrets that
 * could arrive inside request objects are redacted before serialization.
 */
export function createRootLogger(overrides: RootLoggerOverrides = {}): PinoInstance {
  const rawLevel = overrides.level ?? process.env.LOG_LEVEL ?? 'info';
  const level = (VALID_LEVELS as readonly string[]).includes(rawLevel) ? rawLevel : 'info';
  return pino(
    {
      level,
      base: { service: SERVICE_NAME },
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'res.headers["set-cookie"]',
          '**.password',
          '**.accessToken',
          '**.refreshToken',
        ],
        censor: '[redacted]',
      },
    },
    overrides.stream,
  );
}

function looksLikeStack(value: string): boolean {
  return value.includes('\n    at ');
}

function messageText(message: unknown): string {
  if (typeof message === 'string') return message;
  if (message instanceof Error) return message.message;
  try {
    return JSON.stringify(message);
  } catch {
    return String(message);
  }
}

/** Pino levels the facade can emit. */
type PinoLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

/**
 * Adapter so *everything* Nest logs — bootstrap messages, route resolution,
 * `new Logger(...)` call sites like ErrorFormatFilter — comes out of the
 * same pino pipeline as the access logs, as JSON lines, and carries the
 * active request's `reqId` picked up from AsyncLocalStorage.
 *
 * Optional-parameter convention (matches Nest core callers):
 * - trailing plain string  → `context` field
 * - stack-looking string   → `stack` field (ErrorFormatFilter: error(msg, stack))
 * - Error instance         → `err` field (name/message/stack flattened)
 * - plain object           → merged as extra structured fields
 */
export class PinoLoggerService implements LoggerService {
  constructor(private readonly logger: PinoInstance) {}

  private emit(level: PinoLevel, message: unknown, optionalParams: unknown[]): void {
    const fields: Record<string, unknown> = {};
    const reqId = currentReqId();
    if (reqId !== undefined) fields.reqId = reqId;

    let context: string | undefined;
    for (const param of optionalParams) {
      if (param === null || param === undefined) continue;
      if (param instanceof Error) {
        fields.err = { name: param.name, message: param.message, stack: param.stack };
        if (fields.stack === undefined) fields.stack = param.stack;
        continue;
      }
      if (typeof param === 'string') {
        if (looksLikeStack(param)) fields.stack = param;
        else context = param;
        continue;
      }
      if (typeof param === 'object') {
        Object.assign(fields, param as Record<string, unknown>);
      }
    }
    if (context !== undefined) fields.context = context;

    const line = messageText(message);
    (this.logger as unknown as Record<string, (obj: Record<string, unknown>, msg: string) => void>)[level](
      fields,
      line,
    );
  }

  log(message: unknown, ...params: unknown[]): void {
    this.emit('info', message, params);
  }
  error(message: unknown, ...params: unknown[]): void {
    this.emit('error', message, params);
  }
  warn(message: unknown, ...params: unknown[]): void {
    this.emit('warn', message, params);
  }
  debug(message: unknown, ...params: unknown[]): void {
    this.emit('debug', message, params);
  }
  verbose(message: unknown, ...params: unknown[]): void {
    this.emit('trace', message, params);
  }
  fatal(message: unknown, ...params: unknown[]): void {
    this.emit('fatal', message, params);
  }
}
