import * as http from 'http';
import {
  Body,
  CanActivate,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  INestApplication,
  Module,
  NotFoundException,
  Post,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { IsInt, IsOptional, IsString } from 'class-validator';
import { createGlobalValidationPipe } from './app-config';
import { AppException } from './app-exception';
import { ErrorFormatFilter } from './error-format.filter';

class ProbeDto {
  @IsString()
  name!: string;

  @IsOptional()
  @IsInt()
  age?: number;
}

class AlwaysUnauthorizedGuard implements CanActivate {
  canActivate(): boolean {
    throw new UnauthorizedException('Missing bearer token');
  }
}

@Controller('probe')
class ProbeController {
  @Get('ok')
  ok(): { ok: boolean } {
    return { ok: true };
  }

  @Get('not-found')
  notFound(): never {
    throw new NotFoundException('Widget not found');
  }

  @Get('boom')
  boom(): never {
    throw new Error('secret: SELECT failed on table orders');
  }

  @Get('teapot')
  teapot(): never {
    throw new HttpException('I like tea', 418);
  }

  @Post('validate')
  validate(@Body() dto: ProbeDto): ProbeDto {
    return dto;
  }

  @Post('min-order')
  minOrder(): never {
    throw new AppException(HttpStatus.BAD_REQUEST, 'MIN_ORDER_NOT_MET', 'Order is below this restaurant’s minimum', {
      minimumCents: 2000,
      subtotalCents: 1500,
    });
  }

  @UseGuards(AlwaysUnauthorizedGuard)
  @Get('guarded')
  guarded(): { never: true } {
    throw new Error('guard should have rejected first');
  }
}

@Module({ controllers: [ProbeController] })
class ProbeModule {}

function request(
  app: INestApplication,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any; raw: string }> {
  return new Promise((resolve, reject) => {
    const server = app.getHttpServer() as http.Server;
    const port = (server.address() as any).port;
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      { host: '127.0.0.1', port, method, path, headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {} },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => {
          let json: any;
          try {
            json = JSON.parse(raw);
          } catch {
            json = undefined;
          }
          resolve({ status: res.statusCode!, json, raw });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describe('ErrorFormatFilter — live HTTP integration (production pipe + filter config)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ProbeModule] }).compile();
    app = moduleRef.createNestApplication();
    // Exact production wiring from src/main.ts: prefix, real ValidationPipe options, filter.
    app.setGlobalPrefix('api');
    app.useGlobalPipes(createGlobalValidationPipe());
    app.useGlobalFilters(new ErrorFormatFilter());
    await app.listen(0); // ephemeral port
  });

  afterAll(async () => {
    await app?.close();
  });

  it('leaves successful responses untouched', async () => {
    const { status, json } = await request(app, 'GET', '/api/probe/ok');
    expect(status).toBe(200);
    expect(json).toEqual({ ok: true });
  });

  it('NotFoundException → 404 NOT_FOUND envelope', async () => {
    const { status, json } = await request(app, 'GET', '/api/probe/not-found');
    expect(status).toBe(404);
    expect(json).toEqual({ error: { code: 'NOT_FOUND', message: 'Widget not found', details: null } });
  });

  it('unknown route → router 404 also comes back as the envelope', async () => {
    const { status, json } = await request(app, 'GET', '/api/probe/does-not-exist');
    expect(status).toBe(404);
    expect(json).toEqual({ error: { code: 'NOT_FOUND', message: 'Cannot GET /api/probe/does-not-exist', details: null } });
  });

  it('guard exceptions are formatted too', async () => {
    const { status, json } = await request(app, 'GET', '/api/probe/guarded');
    expect(status).toBe(401);
    expect(json.error.code).toBe('UNAUTHORIZED');
    expect(json.error.message).toBe('Missing bearer token');
  });

  it('real ValidationPipe failures: 400 Validation failed + constraint details', async () => {
    const { status, json } = await request(app, 'POST', '/api/probe/validate', {
      name: 123,
      age: 'x',
      userId: 'injected',
    });
    expect(status).toBe(400);
    expect(json.error.code).toBe('BAD_REQUEST');
    expect(json.error.message).toBe('Validation failed');
    expect(json.error.details).toEqual(
      expect.arrayContaining([
        expect.stringContaining('name must be a string'),
        expect.stringContaining('age must be an integer number'),
      ]),
    );
    // whitelist:true *strips* unknown props silently (no forbidNonWhitelisted)
    // — injection is not even reported, and it must never be echoed back.
    expect(json.error.details).toHaveLength(2);
    expect(JSON.stringify(json)).not.toMatch(/injected/);
  });

  it('valid body with an injected unknown prop: accepted, stripped', async () => {
    const { status, json } = await request(app, 'POST', '/api/probe/validate', {
      name: 'rice',
      userId: 'someone-else',
    });
    expect(status).toBe(201);
    expect(json).toEqual({ name: 'rice' });
  });

  it('valid body passes the pipe untouched', async () => {
    const { status, json } = await request(app, 'POST', '/api/probe/validate', { name: 'rice', age: 2 });
    expect(status).toBe(201);
    expect(json).toEqual({ name: 'rice', age: 2 });
  });

  it('unexpected crash is a sanitized 500 — the message leaks nothing', async () => {
    const { status, raw } = await request(app, 'GET', '/api/probe/boom');
    expect(status).toBe(500);
    expect(JSON.parse(raw)).toEqual({
      error: { code: 'INTERNAL_SERVER_ERROR', message: 'Internal server error', details: null },
    });
    expect(raw).not.toMatch(/secret|orders|at ProbeController|stack/i);
  });

  it('custom status 418 keeps message, gets HTTP_418 code', async () => {
    const { status, json } = await request(app, 'GET', '/api/probe/teapot');
    expect(status).toBe(418);
    expect(json).toEqual({ error: { code: 'HTTP_418', message: 'I like tea', details: null } });
  });

  it('AppException explicit code + object details survive the round-trip', async () => {
    const { status, json } = await request(app, 'POST', '/api/probe/min-order');
    expect(status).toBe(400);
    expect(json).toEqual({
      error: {
        code: 'MIN_ORDER_NOT_MET',
        message: 'Order is below this restaurant’s minimum',
        details: { minimumCents: 2000, subtotalCents: 1500 },
      },
    });
  });

  it('malformed JSON body → 400 envelope (Express parse error is caught)', async () => {
    const server = app.getHttpServer() as http.Server;
    const port = (server.address() as any).port;
    const raw = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, method: 'POST', path: '/api/probe/validate', headers: { 'content-type': 'application/json' } },
        (res) => {
          let acc = '';
          res.setEncoding('utf8');
          res.on('data', (c) => (acc += c));
          res.on('end', () => resolve({ status: res.statusCode!, body: acc }));
        },
      );
      req.on('error', reject);
      req.end('{not json');
    });
    expect([400]).toContain(raw.status);
    expect(JSON.parse(raw.body).error.code).toBe('BAD_REQUEST');
  });
});
