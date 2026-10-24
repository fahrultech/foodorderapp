import { Writable } from 'node:stream';
import { runWithRequestContext } from './request-context';
import { createRootLogger, PinoLoggerService } from './pino-logger';

interface Capture {
  lines: Record<string, any>[];
  stream: Writable;
}

/** Collects pino output line-by-line, parsed back from JSON. */
function captureSink(): Capture {
  const lines: Record<string, any>[] = [];
  let buf = '';
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      buf += chunk.toString();
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line.length > 0) lines.push(JSON.parse(line));
      }
      cb();
    },
  });
  return { lines, stream };
}

describe('createRootLogger', () => {
  const original = process.env.LOG_LEVEL;
  afterEach(() => {
    if (original === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = original;
  });

  it('defaults to info and stamps every line with the service name', () => {
    delete process.env.LOG_LEVEL;
    const { lines, stream } = captureSink();
    const logger = createRootLogger({ stream });
    expect(logger.level).toBe('info');
    logger.info('hello');
    expect(lines).toHaveLength(1);
    expect(lines[0].service).toBe('foodorder-api');
    expect(lines[0].level).toBe(30);
    expect(lines[0].msg).toBe('hello');
    expect(lines[0].time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('honours LOG_LEVEL and falls back to info on a bogus value', () => {
    const a = captureSink();
    process.env.LOG_LEVEL = 'warn';
    expect(createRootLogger({ stream: a.stream }).level).toBe('warn');
    process.env.LOG_LEVEL = 'not-a-level';
    expect(createRootLogger({ stream: a.stream }).level).toBe('info');
  });
});

describe('PinoLoggerService', () => {
  function service(): { svc: PinoLoggerService; lines: Record<string, any>[] } {
    const { lines, stream } = captureSink();
    const root = createRootLogger({ level: 'trace', stream });
    return { svc: new PinoLoggerService(root), lines };
  }

  it('maps Nest levels to pino levels', () => {
    const { svc, lines } = service();
    svc.log('a');
    svc.error('b');
    svc.warn('c');
    svc.debug('d');
    svc.verbose('e');
    svc.fatal('f');
    expect(lines.map((l) => l.level)).toEqual([30, 50, 40, 20, 10, 60]);
    expect(lines.map((l) => l.msg)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });

  it('treats a trailing plain string as context (Nest convention)', () => {
    const { svc, lines } = service();
    svc.log('RoutesResolver', 'NestApplication');
    expect(lines[0]).toMatchObject({ msg: 'RoutesResolver', context: 'NestApplication' });
  });

  it('separates stack from context: error(msg, stack, context)', () => {
    const { svc, lines } = service();
    const stack = 'Error: boom\n    at Object.<anonymous> (x.js:1:1)';
    svc.error('Unhandled exception: boom', stack, 'ErrorFormatFilter');
    expect(lines[0]).toMatchObject({
      msg: 'Unhandled exception: boom',
      context: 'ErrorFormatFilter',
      stack,
    });
  });

  it('serializes an Error argument into a structured err field', () => {
    const { svc, lines } = service();
    const err = new Error('disk full');
    svc.error('write failed', err);
    expect(lines[0].err).toMatchObject({ name: 'Error', message: 'disk full' });
    expect(lines[0].stack).toContain('disk full');
  });

  it('merges plain object arguments as extra fields and stringifies object messages', () => {
    const { svc, lines } = service();
    svc.log('order created', { orderId: 'o-1', totalCents: 1300 });
    expect(lines[0]).toMatchObject({ orderId: 'o-1', totalCents: 1300 });
    svc.log({ raw: 'object-message' });
    expect(lines[1].msg).toBe('{"raw":"object-message"}');
  });

  it('attaches reqId from the active request context and omits it otherwise', () => {
    const { svc, lines } = service();
    svc.log('outside any request');
    runWithRequestContext({ reqId: 'req-42' }, () => {
      svc.log('inside request');
      svc.error('also inside', 'ErrorFormatFilter');
    });
    svc.log('after request done');
    expect(lines[0].reqId).toBeUndefined();
    expect(lines[1].reqId).toBe('req-42');
    expect(lines[2].reqId).toBe('req-42');
    expect(lines[3].reqId).toBeUndefined();
  });

  it('survives circular object arguments without throwing', () => {
    const { svc, lines } = service();
    const circular: Record<string, unknown> = { name: 'loop' };
    circular.self = circular;
    svc.log(circular);
    expect(typeof lines[0].msg).toBe('string');
  });
});
