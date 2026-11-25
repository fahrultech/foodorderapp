import * as http from 'http';
import { AddressInfo } from 'net';
import { INestApplication } from '@nestjs/common';
import { Repository } from 'typeorm';
import { Test } from '@nestjs/testing';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';

import { OrdersController } from './orders.controller';
import { OrdersService, normalizeContactEmail } from './orders.service';
import { OrderEventsService } from './order-events.service';
import { ErrorFormatFilter } from '../common/error-format.filter';
import { createGlobalValidationPipe } from '../common/app-config';
import { TOKEN_TYPE_ACCESS } from '../common/tokens';
import { UserRole } from '../users/user.entity';
import { JwtAuthGuard } from '../common/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../common/optional-jwt-auth.guard';
import { RolesGuard } from '../common/roles.guard';
import { RateLimitGuard } from '../common/rate-limit/rate-limit.guard';
import { RATE_LIMIT_CONFIG } from '../common/rate-limit/rate-limit.config';
import { SlidingWindowLogStore } from '../common/rate-limit/rate-limit.store';
import { Order, OrderStatus } from './order.entity';
import { makeRng } from '../common/fuzz/fuzz-harness';

/**
 * Receipt proof-param sweep (Phase 14): property tests over the guest
 * proof on `GET /api/orders/:id?contactEmail=` (API ladder rung 3) and, by
 * chain, the web URL param `?email=` (apps/web forwards it percent-encoded
 * through `api.getOrder`), pinned against the REAL presenter ladder:
 * real OrdersController + real OrdersService.findOneForViewer + real
 * ValidationPipe + real ErrorFormatFilter over live HTTP. The service edge
 * itself is specced in orders-ownership.spec.ts (mocked transport); THIS
 * spec covers what only a real query parser can teach:
 *   - the raw `+` wire trap: an unencoded '+' decodes to a SPACE before
 *     the normalizer ever runs, so a plus-containing email (session-76's
 *     dot-address fixture class) unlocks ONLY percent-encoded;
 *   - trim/casefold edges incl. non-ASCII folding (toLowerCase is NOT
 *     transliteration and NOT homoglyph folding; the Turkish dotted/dotless
 *     I pair exposes its asymmetry; İ folds to TWO code points);
 *   - transport junk a raw @Query param receives with no DTO to protect
 *     it: repeated keys (array), object bracket syntax (object) — these
 *     must DENY as the canonical 404, never 500 (session-84 non-5xx
 *     doctrine), and must NOT disturb the bearer rungs that short-circuit
 *     the proof check;
 *   - no oracle drift: EVERY denial (unknown id, wrong proof, missing,
 *     empty, whitespace-only, junk shapes, NULL-stored rows) answers the
 *     byte-identical `{"error":{"code":"NOT_FOUND",...}}` envelope.
 * Plus two seeded property sweeps (deterministic; a FAIL prints its seed):
 *   - agreement: the HTTP outcome equals the pure-normalizer prediction
 *     `normalizeContactEmail(presentation) === stored` for 160 generated
 *     presentations (the wire must not drift from the ladder's oracle);
 *   - write-chain: any raw checkout string R unlocks the order whose
 *     stored email IS normalizeContactEmail(R) — exactly what create()
 *     persists (orders.service.ts, contactEmail write) — for 60 R.
 */

const JWT_TEST = 'receipt-proof-sweep-http-spec';

// Runtime-assembled non-ASCII (source stays pure ASCII).
const DOT_ABOVE = String.fromCodePoint(0x0307); // combining dot above
const TURKISH_I_CAP = String.fromCodePoint(0x0130); // capital I with dot above
const SHARP_S_CAP = String.fromCodePoint(0x1e9e); // capital sharp s
const DOTLESS_I = String.fromCodePoint(0x0131); // small dotless i
const CYR_E = String.fromCodePoint(0x0435); // cyrillic small ie (ASCII-e homoglyph)
const NBSP = String.fromCodePoint(0x00a0);
const THIN = String.fromCodePoint(0x2009);
const IDEOGRAPHIC = String.fromCodePoint(0x3000);
const ZWNBSP = String.fromCodePoint(0xfeff);
const VT = String.fromCodePoint(0x000b);
const FF = String.fromCodePoint(0x000c);
const LS = String.fromCodePoint(0x2028);
const PS = String.fromCodePoint(0x2029);
const NUL = String.fromCodePoint(0x0000);

const ORDER_ID = '9d9d9d9d-9d9d-4d9d-8d9d-9d9d9d9d9d9d';
const UNKNOWN_ID = '1a1a1a1a-1a1a-4a1a-8a1a-1a1a1a1a1a1a';
const OWNER_ID = '2b2b2b2b-2b2b-4b2b-8b2b-2b2b2b2b2b2b';
const OTHER_ID = '3c3c3c3c-3c3c-4c3c-8c3c-3c3c3c3c3c3c';
const REST_ID = '4d4d4d4d-4d4d-4d4d-8d4d-4d4d4d4d4d4d';

/** The canonical denial an unknown uuid answers — every other 404 must equal it. */
const CANONICAL_404 = JSON.stringify({
  error: { code: 'NOT_FOUND', message: 'Order not found', details: null },
});

const PLUS = 'first.last+tag@example.com'; // normalized write shape (session-76 dot-address fixture class)

type Fixture = Partial<Order> | null;
type Tokens = { owner: string; other: string; admin: string };

const fixtures = (map: Record<string, Fixture> = {}): Map<string, Fixture> =>
  new Map<string, Fixture>([
    [ORDER_ID, {
      id: ORDER_ID,
      code: 'FO-SWEEP',
      status: OrderStatus.PENDING,
      userId: OWNER_ID,
      contactEmail: PLUS,
      restaurantId: REST_ID,
      items: [],
    }],
    ...Object.entries(map),
  ]);

async function boot(initial: Map<string, Fixture>) {
  const repo = {
    findOne: jest.fn(async (opts: any) => {
      const f = initial.get(opts?.where?.id);
      return f ? { ...f } : null;
    }),
  } as unknown as Repository<Order>;
  const svc = new OrdersService(
    repo,
    {} as any,
    {} as any,
    new OrderEventsService(),
    {} as any,
    {} as any,
  );

  const moduleRef = await Test.createTestingModule({
    imports: [JwtModule.register({ secret: JWT_TEST })],
    controllers: [OrdersController],
    providers: [
      JwtAuthGuard,
      OptionalJwtAuthGuard,
      RolesGuard,
      RateLimitGuard,
      Reflector,
      { provide: OrdersService, useValue: svc },
      { provide: SlidingWindowLogStore, useValue: {} },
      { provide: RATE_LIMIT_CONFIG, useValue: { rules: {} } },
    ],
  }).compile();

  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api');
  app.useGlobalPipes(createGlobalValidationPipe());
  app.useGlobalFilters(new ErrorFormatFilter());
  await app.listen(0);

  const jwt = app.get(JwtService);
  const tokens: Tokens = {
    owner: await jwt.signAsync({ sub: OWNER_ID, role: UserRole.CUSTOMER, typ: TOKEN_TYPE_ACCESS }),
    other: await jwt.signAsync({ sub: OTHER_ID, role: UserRole.CUSTOMER, typ: TOKEN_TYPE_ACCESS }),
    admin: await jwt.signAsync({ sub: OTHER_ID, role: UserRole.ADMIN, typ: TOKEN_TYPE_ACCESS }),
  };
  return { app, tokens };
}

function read(
  app: INestApplication,
  qs: string,
  opts: { token?: string; id?: string } = {},
): Promise<{ status: number; json: any; raw: string }> {
  return new Promise((resolve, reject) => {
    const port = (app.getHttpServer().address() as AddressInfo).port;
    const headers: Record<string, string> = {};
    if (opts.token) headers['authorization'] = `Bearer ${opts.token}`;
    const path = `/api/orders/${opts.id ?? ORDER_ID}${qs ? `?${qs}` : ''}`;
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path, headers }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        let json: any;
        try { json = JSON.parse(raw); } catch { json = undefined; }
        resolve({ status: res.statusCode!, json, raw });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

/** Proof exactly as lib/api.ts + the web `?email=` chain send it: one encoded value. */
const enc = (v: string) => `contactEmail=${encodeURIComponent(v)}`;

/** Run one property case; any assertion failure rethrows with seed+case context (fuzz idiom). */
async function attempt(ctx: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e: any) {
    throw new Error(`${ctx}\n  → ${e?.message ?? e}`);
  }
}

describe('receipt proof sweep — wire ladder over real HTTP', () => {
  let app: INestApplication;
  let tokens: Tokens;

  async function start(map: Map<string, Fixture> = fixtures()) {
    const booted = await boot(map);
    app = booted.app;
    tokens = booted.tokens;
  }
  afterEach(async () => { await app?.close(); });

  it('unlocks with the exact percent-encoded stored proof', async () => {
    await start();
    const res = await read(app, enc(PLUS));
    expect(res.status).toBe(200);
    expect(res.json.id).toBe(ORDER_ID);
    expect(res.json.contactEmail).toBe(PLUS);
  });

  it('raw-plus trap: unencoded + decodes to a space and DENIES; %2B and %40 unlock', async () => {
    await start();
    // A client that forgets encodeURIComponent sends the literal '+';
    // query decoding turns it into ' ' BEFORE normalizeContactEmail runs —
    // an internal space trim can no longer reach, so the proof mismatches.
    const raw = await read(app, 'contactEmail=first.last+tag@example.com');
    expect(raw.status).toBe(404);
    expect(raw.raw).toBe(CANONICAL_404);
    // Double-encoding lands as the literal '%2B' text: deny.
    expect((await read(app, 'contactEmail=first.last%252Btag%40example.com')).status).toBe(404);
    // Percent-encoding the '+' unlocks; an unreserved '@' also decodes fine.
    expect((await read(app, 'contactEmail=first.last%2Btag@example.com')).status).toBe(200);
  });

  it('ASCII case folds fully: any case presentation of the proof unlocks', async () => {
    await start();
    expect((await read(app, enc('FIRST.LAST+TAG@EXAMPLE.COM'))).status).toBe(200);
    expect((await read(app, enc('First.Last+Tag@Example.cOM'))).status).toBe(200);
  });

  it.each([
    ['plain spaces', ' ' + PLUS + ' '],
    ['tab + CR/LF', `\t${PLUS}\r\n`],
    ['VT + FF', `${VT}${PLUS}${FF}`],
    ['NBSP / THIN / IDEOGRAPHIC', `${NBSP}${THIN}${PLUS}${IDEOGRAPHIC}${NBSP}`],
    ['ZWNBSP', `${ZWNBSP}${PLUS}${ZWNBSP}`],
    ['line/para separators', `${LS}${PLUS}${PS}`],
  ])('trim eats JS-whitespace padding: %s', async (_name, presentation) => {
    await start();
    const res = await read(app, enc(presentation));
    expect(res.status).toBe(200);
  });

  it('internal whitespace is not trimmable: denies as canonical 404', async () => {
    await start();
    const res = await read(app, enc('first.last + tag@example.com'));
    expect(res.status).toBe(404);
    expect(res.raw).toBe(CANONICAL_404);
  });

  it('wrong / missing / empty / whitespace-only proofs all answer the SAME 404', async () => {
    await start();
    const denials = await Promise.all([
      read(app, enc('someone.else@example.com')),
      read(app, ''),
      read(app, 'contactEmail='),
      read(app, 'contactEmail=%20%09%0a'),
    ]);
    for (const res of denials) {
      expect(res.status).toBe(404);
      expect(res.raw).toBe(CANONICAL_404);
    }
  });

  it('NUL and oversize proofs deny without tripping the transport', async () => {
    await start();
    expect((await read(app, enc(`${NUL}${PLUS}`))).status).toBe(404); // NUL is NOT JS whitespace
    expect((await read(app, enc(`${'x'.repeat(3000)}@example.com`))).status).toBe(404);
  });

  it('NULL-stored email (legacy row) has no rung 3: every proof denies, bearer rungs still work', async () => {
    await start(fixtures({
      [ORDER_ID]: {
        id: ORDER_ID, code: 'FO-LEGACY', status: OrderStatus.PENDING,
        userId: OWNER_ID, contactEmail: null, restaurantId: REST_ID, items: [],
      },
    }));
    for (const proof of [PLUS, '', 'anything@example.com']) {
      const res = await read(app, proof ? enc(proof) : '');
      expect(res.status).toBe(404);
      expect(res.raw).toBe(CANONICAL_404);
    }
    expect((await read(app, '', { token: tokens.owner })).status).toBe(200);
    expect((await read(app, '', { token: tokens.admin })).status).toBe(200);
  });

  it('bearer ladder is proof-independent: owner/ADMIN unlock with ZERO proof, foreign bearer needs rung 3', async () => {
    await start();
    expect((await read(app, '', { token: tokens.owner })).status).toBe(200);
    expect((await read(app, '', { token: tokens.admin })).status).toBe(200);
    // Foreign customer bearer: still only rung 3 saves it.
    expect((await read(app, '', { token: tokens.other })).status).toBe(404);
    expect((await read(app, enc(PLUS), { token: tokens.other })).status).toBe(200);
  });

  it('garbage bearer header degrades to guest (OptionalJwtAuthGuard): rung 3 still unlocks', async () => {
    await start();
    expect((await read(app, enc(PLUS), { token: 'not.a.jwt' })).status).toBe(200);
    const wrong = await read(app, enc('nope@example.com'), { token: 'not.a.jwt' });
    expect(wrong.status).toBe(404);
    expect(wrong.raw).toBe(CANONICAL_404);
  });

  it('non-string wire shapes (repeated key = array, bracket object) DENY — never 500', async () => {
    await start();
    // Raw @Query params have no DTO. PROVEN wire truth (probe, express 5.2.1
    // + this global ValidationPipe): repeated keys arrive as an ARRAY that
    // the String-metatype pipe layer String()-coerces to 'a,b' — and since
    // @IsEmail at create time can never store a comma, that join can never
    // collide with a real proof. Bracket syntax stays a literal unmatched
    // key (undefined). Both paths must DENY as the canonical 404, never 5xx
    // (session-84 doctrine). normalizeContactEmail's own typeof guard pins
    // the same collapse for direct (non-HTTP) callers.
    for (const qs of [
      'contactEmail=a@example.com&contactEmail=b@example.com', // repeated -> array -> 'a,b'
      'contactEmail[x]=y', // bracket -> literal key, never contactEmail
      'contactEmail[a]=x&contactEmail[b]=y', // dotted object form
      'contactEmail[]=' + encodeURIComponent(PLUS), // the RIGHT proof smuggled through an array key
    ]) {
      const res = await read(app, qs);
      expect(res.status).toBe(404);
      expect(res.raw).toBe(CANONICAL_404);
    }
  });

  it('bearer rungs SURVIVE junk proof (array/object must not poison rung 1/2)', async () => {
    await start();
    const junk = 'contactEmail=a&contactEmail=b';
    expect((await read(app, junk, { token: tokens.owner })).status).toBe(200);
    expect((await read(app, 'contactEmail[a]=x&contactEmail[b]=y', { token: tokens.admin })).status).toBe(200);
  });
});

describe('receipt proof sweep — non-ASCII case folding edges', () => {
  let app: INestApplication;

  async function startWith(stored: string) {
    const booted = await boot(fixtures({
      [ORDER_ID]: {
        id: ORDER_ID, code: 'FO-UNI', status: OrderStatus.PENDING,
        userId: OWNER_ID, contactEmail: stored, restaurantId: REST_ID, items: [],
      },
    }));
    app = booted.app;
  }
  afterEach(async () => { await app?.close(); });

  it('Turkish capital I-with-dot: store and present BOTH fold to i + U+0307 (two code points)', async () => {
    // write path: create() persists normalizeContactEmail(R), so a checkout
    // of TURKISH_I_CAP + 'z@ex.com' stores the two-codepoint fold; the
    // identical raw presentation re-folds to the same string -> unlock.
    const stored = TURKISH_I_CAP.toLowerCase() + 'z@ex.com';
    expect(stored).toBe(`i${DOT_ABOVE}z@ex.com`); // pinned JS fold truth, not folklore
    await startWith(stored);
    expect((await read(app, enc(`${TURKISH_I_CAP}z@ex.com`))).status).toBe(200);
    expect((await read(app, enc(`i${DOT_ABOVE}Z@ex.com`))).status).toBe(200); // ascii case on the rest folds too
    // The ASCII-abbreviation 'iz' and the dot-stripped forms are DIFFERENT strings: deny.
    expect((await read(app, enc('iz@ex.com'))).status).toBe(404);
    expect((await read(app, enc('iZ@ex.com'.toLowerCase()))).status).toBe(404);
  });

  it('ASCII I never folds to dotless ı, and vice versa: the Turkish asymmetry', async () => {
    await startWith(`${DOTLESS_I}user@ex.com`); // stored as the lowercase of a dotless checkout
    expect((await read(app, enc(`${DOTLESS_I.toUpperCase()}USER@ex.com`))).status).toBe(404);
    // DOTLESS_I.toUpperCase() is 'I'; presenting ASCII 'I...' normalizes to 'i...' — mismatch.
    expect((await read(app, enc('IUSER@ex.com'))).status).toBe(404);
    expect((await read(app, enc(`${DOTLESS_I}user@ex.com`))).status).toBe(200);
  });

  it('sharp-s: capital SHARP_S folds to small sharp s, but STRASSE never equals str-a-sharp-e', async () => {
    // The write path stored normalizeContactEmail('STRA' + SHARP_S_CAP + 'E@...')
    // -> str + a + ß + e. Lowercasing folds 1:1; it NEVER expands to 'SS'.
    const stored = `stra${String.fromCodePoint(0x00df)}e@ex.com`;
    await startWith(stored);
    expect((await read(app, enc(`STRA${SHARP_S_CAP}E@EX.COM`))).status).toBe(200);
    expect((await read(app, enc('STRASSE@ex.com'))).status).toBe(404); // folding is not transliteration
  });

  it('homoglyphs stay distinct: cyrillic е does not fold into ASCII e', async () => {
    await startWith('user@ex.com');
    expect((await read(app, enc(`us${CYR_E}r@ex.com`))).status).toBe(404);
  });
});

describe('receipt proof sweep — no oracle drift across the denial family', () => {
  let app: INestApplication;
  let tokens: Tokens;

  beforeAll(async () => {
    const booted = await boot(fixtures({
      [ORDER_ID]: {
        id: ORDER_ID, code: 'FO-NULL', status: OrderStatus.PENDING,
        userId: OWNER_ID, contactEmail: null, restaurantId: REST_ID, items: [],
      },
    }));
    app = booted.app;
    tokens = booted.tokens;
  });
  afterAll(async () => { await app?.close(); });

  it('every denial family answers the byte-identical unknown-id 404 envelope', async () => {
    const baseline = await read(app, '', { id: UNKNOWN_ID });
    expect(baseline.status).toBe(404);
    expect(baseline.raw).toBe(CANONICAL_404);
    const denials = await Promise.all([
      read(app, ''), // known id, no proof, NULL-stored row
      read(app, enc('any@ex.com')), // proof presented, row has none
      read(app, enc('whatever@ex.com'), { token: tokens.other }), // foreign bearer + irrelevant proof
      read(app, 'contactEmail=a&contactEmail=b'), // array junk
      read(app, 'contactEmail[x]=y'), // bracket junk
      read(app, 'contactEmail='), // empty value
      read(app, `contactEmail=${'x'.repeat(4096)}`), // oversize
      read(app, '', { token: 'garbage' }), // invalid bearer degrades to guest
      read(app, enc(PLUS), { id: UNKNOWN_ID }), // right proof, unknown id
    ]);
    for (const res of denials) {
      expect(res.status).toBe(404);
      expect(res.raw).toBe(baseline.raw);
    }
  });
});

describe('receipt proof sweep — seeded property sweeps', () => {
  let app: INestApplication;
  let store: Map<string, Fixture>;

  async function start() {
    store = fixtures();
    const booted = await boot(store);
    app = booted.app;
  }
  beforeEach(async () => { await start(); });
  afterEach(async () => { await app.close(); });

  /**
   * AGREEMENT: for generated presentations p, the HTTP unlock must be
   * exactly what the ladder's oracle predicts:
   *   200  <=>  normalizeContactEmail(p) === stored
   * (proof compared against the stored string only; bearer rungs untouched).
   */
  it('160 generated presentations: HTTP outcome === pure-normalizer prediction', async () => {
    const rng = makeRng(0xC0FFEE);
    const WS = [' ', '\t', '\n', '\r', NBSP, THIN, IDEOGRAPHIC, ZWNBSP, VT, FF, LS, PS, '', ''];
    const POOL = 'abcdefghijklmnopqrstuvwxyz0123456789.-+@'.split('');
    const mutate = (s: string): string => {
      const op = rng.int(7);
      const i = rng.int(s.length || 1);
      switch (op) {
        case 0: return s.slice(0, i) + s.slice(i).toUpperCase();
        case 1: return rng.pick(WS) + s + rng.pick(WS);
        case 2: return s.slice(0, i) + rng.pick(POOL) + s.slice(i + 1);
        case 3: return s.slice(0, i) + rng.pick(POOL) + s.slice(i);
        case 4: return s.slice(0, i) + s.slice(i + 1);
        case 5: return rng.pick(WS) + s;
        default: return s.toUpperCase() === s ? s.toLowerCase() : s.toUpperCase();
      }
    };
    let unlocked = 0;
    let denied = 0;
    for (let n = 0; n < 160; n++) {
      const presentation = mutate(PLUS);
      const expectUnlock = normalizeContactEmail(presentation) === PLUS;
      await attempt(`agreement seed=0xC0FFEE n=${n} p=${JSON.stringify(presentation)}`, async () => {
        const res = await read(app, enc(presentation));
        expect(res.status).toBe(expectUnlock ? 200 : 404);
        if (!expectUnlock) expect(res.raw).toBe(CANONICAL_404);
      });
      if (expectUnlock) unlocked++; else denied++;
    }
    expect(unlocked).toBeGreaterThan(0);
    expect(denied).toBeGreaterThan(0);
  });

  /**
   * WRITE CHAIN: create() stores normalizeContactEmail(R) for the raw
   * checkout value R (orders.service.ts). So presenting R (encoded, exactly
   * as web history/checkout links do) must unlock ANY order created from R.
   */
  it('60 raw checkout strings: the stored normalization round-trips through the wire proof', async () => {
    const rng = makeRng(0xBADB0B);
    const LOCAL = ['guest', 'first.last', 'a+tag', 'big.U_user', 'x'];
    const DOM = ['example.com', 'Example.de', 'mail.co.id', 'JOE.EXAMPLE.ORG'];
    const WS = [' ', '\t', NBSP, ''];
    for (let n = 0; n < 60; n++) {
      const rawCheckout = `${rng.pick(WS)}${rng.pick(LOCAL)}@${rng.pick(DOM)}${rng.pick(WS)}`;
      store.set(ORDER_ID, {
        id: ORDER_ID, code: 'FO-CHAIN', status: OrderStatus.PENDING,
        userId: OWNER_ID, restaurantId: REST_ID, items: [],
        // EXACTLY what create() persists for this raw dto value:
        contactEmail: normalizeContactEmail(rawCheckout),
      });
      await attempt(`chain seed=0xBADB0B n=${n} raw=${JSON.stringify(rawCheckout)}`, async () => {
        const res = await read(app, enc(rawCheckout));
        expect(res.status).toBe(200);
        expect(res.json.id).toBe(ORDER_ID);
        expect(res.json.contactEmail).toBe(normalizeContactEmail(rawCheckout));
      });
    }
  });

  it('normalize is idempotent and collapse-safe (the ladder relies on it)', () => {
    const rng = makeRng(0x1D00D);
    const shapes = [
      PLUS, ` ${PLUS.toUpperCase()} `, 'guest@x.io', '', '   ', NUL,
      `${TURKISH_I_CAP}@x.com`, `${DOTLESS_I}@x.com`, 'a@b\n',
    ];
    for (let n = 0; n < 40; n++) shapes.push(`${rng.pick(shapes)}${rng.pick(['', ' ', '\t'])}`);
    for (const s of shapes) {
      const once = normalizeContactEmail(s);
      expect(normalizeContactEmail(once)).toEqual(once); // re-normalizing a normalized value changes nothing
      if (once !== null) {
        expect(once).toBe(once.trim());
        expect(once).toBe(once.toLowerCase());
        expect(once.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('normalizeContactEmail — direct-call input shapes (typeof guard)', () => {
  // The HTTP wire collapses these shapes upstream (String()-metatype pipe
  // coercion); these rows pin that the helper itself denies non-strings for
  // direct callers too — a future `any`-typed param must still DENY, never
  // TypeError into a 500.
  it.each([
    ['array (repeated wire key)', ['guest@example.com', PLUS]],
    ['nested object (bracket wire key)', { a: PLUS }],
    ['number', 42],
    ['boolean', true],
  ])('%s collapses to null', (_name, value) => {
    expect(normalizeContactEmail(value as any)).toBeNull();
  });
});
