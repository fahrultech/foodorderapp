import * as http from 'http';
import { AddressInfo } from 'net';
import { HttpStatus, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { SearchController } from './search.controller';
import { SearchService } from './search.service';
import { ErrorFormatFilter } from '../common/error-format.filter';
import { createGlobalValidationPipe } from '../common/app-config';

/**
 * HTTP-surface spec for the PUBLIC fuzzy search route (GET /api/search):
 * the real global ValidationPipe (whitelist+transform+forbidUnknownValues)
 * and ErrorFormatFilter over live HTTP, SearchService mocked. Proves the
 * DTO contract and the standard 400 envelope WITHOUT touching a database —
 * the SQL itself is pinned in search.service.spec, the real behaviour in
 * the live smoke (see DEVLOG session 69).
 */

function httpReq(app: INestApplication, path: string): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const port = (app.getHttpServer().address() as AddressInfo).port;
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        let json: any;
        try { json = JSON.parse(raw); } catch { json = undefined; }
        resolve({ status: res.statusCode!, json });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

const SAMPLE = {
  query: 'sushi',
  limit: 10,
  restaurants: [],
  dishes: [{ id: 'd1', name: 'Salmon Nigiri', priceCents: 900 }],
};

async function boot() {
  const search = jest.fn(async () => SAMPLE);
  const moduleRef = await Test.createTestingModule({
    controllers: [SearchController],
    providers: [{ provide: SearchService, useValue: { search } }],
  }).compile();

  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api');
  app.useGlobalPipes(createGlobalValidationPipe());
  app.useGlobalFilters(new ErrorFormatFilter());
  await app.listen(0);
  return { app, search };
}

describe('GET /api/search — query DTO over real HTTP', () => {
  let app: INestApplication;
  let search: jest.Mock;

  beforeAll(async () => {
    ({ app, search } = await boot());
  });
  afterAll(() => app.close());
  beforeEach(() => search.mockClear());

  it('answers 200 with the service result and typed args', async () => {
    const res = await httpReq(app, '/api/search?q=sushi&limit=5');
    expect(res.status).toBe(HttpStatus.OK);
    expect(res.json).toEqual(SAMPLE);
    expect(search).toHaveBeenCalledWith('sushi', 5); // '5' TRANSFORMED to number
  });

  it('trims the query before the service sees it', async () => {
    const res = await httpReq(app, '/api/search?q=%20%20rendang%20');
    expect(res.status).toBe(HttpStatus.OK);
    expect(search).toHaveBeenCalledWith('rendang', undefined);
  });

  it('rejects a missing q with the standard 400 envelope', async () => {
    const res = await httpReq(app, '/api/search');
    expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    expect(res.json.error.code).toBe('BAD_REQUEST');
    expect(Array.isArray(res.json.error.details)).toBe(true);
    expect(search).not.toHaveBeenCalled();
  });

  it('rejects blank (whitespace-only) q — trim THEN min-length', async () => {
    const res = await httpReq(app, '/api/search?q=%20%20');
    expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    // The DTO's own message lands in `details` (envelope message is the
    // generic validation text — clients switch on code, humans on details).
    expect(res.json.error.code).toBe('BAD_REQUEST');
    expect(JSON.stringify(res.json.error.details)).toMatch(/q must not be empty/);
    expect(search).not.toHaveBeenCalled();
  });

  it('rejects q longer than 100 characters', async () => {
    const res = await httpReq(app, `/api/search?q=${'a'.repeat(101)}`);
    expect(res.status).toBe(HttpStatus.BAD_REQUEST);
  });

  it.each([
    ['0', 'below Min(1)'],
    ['26', 'above Max(25)'],
    ['1.5', 'not an integer'],
    ['abc', 'not a number'],
  ])('rejects limit=%s (%s)', async (bad) => {
    const res = await httpReq(app, `/api/search?q=x&limit=${bad}`);
    expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    expect(search).not.toHaveBeenCalled();
  });

  it('whitelist-strips unknown query params (they never reach the service)', async () => {
    const res = await httpReq(app, '/api/search?q=x&sort=name&status=confirmed');
    expect(res.status).toBe(HttpStatus.OK);
    // search(q, limit) is the whole signature — no third object smuggles in.
    expect(search).toHaveBeenCalledWith('x', undefined);
    expect(search.mock.calls[0][2]).toBeUndefined();
  });
});
