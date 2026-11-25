import * as http from 'http';
import { AddressInfo } from 'net';
import { INestApplication } from '@nestjs/common';
import { Repository } from 'typeorm';
import { Test } from '@nestjs/testing';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';

import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { OrderEventsService } from './order-events.service';
import {
  DEFAULT_RECEIPT_TOKEN_TTL_SEC,
  MAX_RECEIPT_TOKEN_LEN,
  issueReceiptAccessToken,
  verifyReceiptAccessToken,
} from './receipt-access';
import { makeRng, encodeParam, Rng } from '../common/fuzz/fuzz-harness';
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

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Magic-link receipt rung (Phase 14 #5) pinned over the REAL HTTP ladder:
 * real OrdersController + real OrdersService.findOneForViewer + real
 * ValidationPipe + ErrorFormatFilter over live sockets (same harness shape
 * as receipt-proof-sweep.http.spec.ts). `?rt=` is rung 4:
 *   - a valid token unlocks a receipt with NO bearer and NO typed email —
 *     including the guest orders the emails actually go to;
 *   - the bearer rungs stay byte-identical (garbage rt beside a valid
 *     owner bearer still rides rung 2);
 *   - every denial (foreign, tampered, expired, structurally junk,
 *     repeated-key array transport, inert config) answers the byte-identical
 *     canonical 404 — no oracle drift, no 5xx (session 84/132 doctrine);
 *   - without a JWT_SECRET visible to the service the rung is INERT:
 *     the token is just junk query data.
 */

const JWT_TEST = 'magic-link-http-spec-auth-secret';
const RECEIPT_TEST = 'magic-link-http-spec-receipt-secret';

const ORDER_ID = '9d9d9d9d-9d9d-4d9d-8d9d-9d9d9d9d9d9d';
const OTHER_ORDER_ID = '1a1a1a1a-1a1a-4a1a-8a1a-1a1a1a1a1a1a';
const UNKNOWN_ID = '7e7e7e7e-7e7e-4e7e-8e7e-7e7e7e7e7e7e';
const OWNER_ID = '2b2b2b2b-2b2b-4b2b-8b2b-2b2b2b2b2b2b';
const REST_ID = '4d4d4d4d-4d4d-4d4d-8d4d-4d4d4d4d4d4d';

const CANONICAL_404 = JSON.stringify({
  error: { code: 'NOT_FOUND', message: 'Order not found', details: null },
});

type Fixture = Partial<Order> | null;

const fixtures = (): Map<string, Fixture> =>
  new Map<string, Fixture>([
    [ORDER_ID, {
      id: ORDER_ID,
      code: 'FO-MAGIC',
      status: OrderStatus.PENDING,
      userId: OWNER_ID,
      contactEmail: 'guest+magic@example.com',
      restaurantId: REST_ID,
      items: [],
    }],
    [OTHER_ORDER_ID, {
      id: OTHER_ORDER_ID,
      code: 'FO-OTHER',
      status: OrderStatus.PENDING,
      userId: null, // the real guest-order shape the emails serve
      contactEmail: 'other@example.com',
      restaurantId: REST_ID,
      items: [],
    }],
  ]);

/**
 * `secrets` controls what the service can see through ConfigService —
 * the INERT-rung arm passes none, exactly like the bare unit harnesses.
 */
async function boot(opts: { receiptSecret?: string } = {}) {
  const initial = fixtures();
  const repo = {
    findOne: jest.fn(async (q: any) => {
      const f = initial.get(q?.where?.id);
      return f ? { ...f } : null;
    }),
  } as unknown as Repository<Order>;
  const config = opts.receiptSecret === undefined
    ? undefined
    : { get: (key: string) => (key === 'JWT_SECRET' ? opts.receiptSecret : undefined) };
  const svc = new OrdersService(
    repo,
    {} as any,
    {} as any,
    new OrderEventsService(),
    {} as any,
    {} as any,
    undefined, // payments repo (gate inert)
    config as any,
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
  const tokens = {
    owner: await jwt.signAsync({ sub: OWNER_ID, role: UserRole.CUSTOMER, typ: TOKEN_TYPE_ACCESS }),
    admin: await jwt.signAsync({ sub: 'ffffffffff-4a4a-8a4a-8a4a-1a1a1a1a1a1a', role: UserRole.ADMIN, typ: TOKEN_TYPE_ACCESS }),
  };
  return { app, tokens };
}

function read(
  app: INestApplication,
  qs: string,
  opts: { bearer?: string; id?: string } = {},
): Promise<{ status: number; raw: string }> {
  return new Promise((resolve, reject) => {
    const port = (app.getHttpServer().address() as AddressInfo).port;
    const headers: Record<string, string> = {};
    if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
    const path = `/api/orders/${opts.id ?? ORDER_ID}${qs ? `?${qs}` : ''}`;
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path, headers }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (raw += c));
      res.on('end', () => resolve({ status: res.statusCode!, raw }));
    });
    req.on('error', reject);
    req.end();
  });
}

const mint = (id: string, ttl: number = DEFAULT_RECEIPT_TOKEN_TTL_SEC) =>
  issueReceiptAccessToken(id, RECEIPT_TEST, ttl);

describe('GET /api/orders/:id?rt= — the magic-link rung over real HTTP', () => {
  let app: INestApplication;
  let tokens: { owner: string; admin: string };

  beforeAll(async () => {
    ({ app, tokens } = await boot({ receiptSecret: RECEIPT_TEST }));
  });
  afterAll(async () => { await app.close(); });

  it('valid token unlocks the receipt for a total stranger (no bearer, no email)', async () => {
    const r = await read(app, `rt=${mint(ORDER_ID)}`);
    expect(r.status).toBe(200);
    expect(JSON.parse(r.raw).code).toBe('FO-MAGIC');
  });
  it('valid token unlocks a GUEST order (userId NULL) — the email-recipient case', async () => {
    const r = await read(app, `rt=${mint(OTHER_ORDER_ID)}`, { id: OTHER_ORDER_ID });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.raw).code).toBe('FO-OTHER');
  });
  it('token minted for ANOTHER order denies with the canonical 404', async () => {
    const r = await read(app, `rt=${mint(OTHER_ORDER_ID)}`);
    expect(r.status).toBe(404);
    expect(r.raw).toBe(CANONICAL_404);
  });
  it('tampered token denies byte-identically', async () => {
    const tok = mint(ORDER_ID);
    const [p, s] = tok.split('.');
    const flip = (b: string) => (b[0] === 'A' ? 'B' + b.slice(1) : 'A' + b.slice(1));
    for (const bad of [`${flip(p)}.${s}`, `${p}.${flip(s)}`, tok.slice(0, -4), 'not-even-close']) {
      const r = await read(app, `rt=${bad}`);
      expect(r.status).toBe(404);
      expect(r.raw).toBe(CANONICAL_404);
    }
  });
  it('expired token denies (1s ttl, presented after it ages out)', async () => {
    const tok = mint(ORDER_ID, 1);
    expect((await read(app, `rt=${tok}`)).status).toBe(200);
    await sleep(1600);
    const r = await read(app, `rt=${tok}`);
    expect(r.status).toBe(404);
    expect(r.raw).toBe(CANONICAL_404);
  });
  it('junk rt shapes answer 404 never 5xx: empty, repeated keys, brackets, oversize', async () => {
    for (const qs of [
      'rt=',
      `rt=${mint(ORDER_ID)}&rt=${mint(OTHER_ORDER_ID)}`, // pipe String()-joins to 'a,b'
      'rt[a]=b',
      `rt=${'x'.repeat(5000)}`,
    ]) {
      const r = await read(app, qs);
      expect(r.status).toBe(404);
      expect(r.raw).toBe(CANONICAL_404);
    }
  });
  it('unknown id + valid-for-it token still 404s (the repo miss precedes the rung)', async () => {
    const r = await read(app, `rt=${mint(UNKNOWN_ID)}`, { id: UNKNOWN_ID });
    expect(r.status).toBe(404);
    expect(r.raw).toBe(CANONICAL_404);
  });

  it('bearer ladder unchanged: owner bearer + garbage rt rides rung 2', async () => {
    const r = await read(app, 'rt=garbage', { bearer: tokens.owner });
    expect(r.status).toBe(200);
  });
  it('typed contact-email proof keeps working untouched', async () => {
    const r = await read(app, 'contactEmail=guest%2Bmagic%40example.com');
    expect(r.status).toBe(200);
  });
  it('ADMIN bearer + expired rt still reads (rung order, not token order)', async () => {
    const tok = mint(ORDER_ID, 1);
    await sleep(1600);
    const r = await read(app, `rt=${tok}`, { bearer: tokens.admin });
    expect(r.status).toBe(200);
  });

  it('percent-encoded rt survives the wire (token is base64url: no special chars)', async () => {
    const tok = mint(ORDER_ID);
    const enc = encodeURIComponent(tok);
    expect(enc).toBe(tok); // URL-safe by construction — emails must not mangle it
    const r = await read(app, `rt=${enc}`);
    expect(r.status).toBe(200);
  });
});

describe('inert rung — no JWT_SECRET visible to the service', () => {
  let app: INestApplication;

  beforeAll(async () => {
    ({ app } = await boot()); // config undefined: every bare unit harness
  });
  afterAll(async () => { await app.close(); });

  it('a would-be-valid token is just junk query data: 404 canonical', async () => {
    const r = await read(app, `rt=${mint(ORDER_ID)}`);
    expect(r.status).toBe(404);
    expect(r.raw).toBe(CANONICAL_404);
  });
  it('empty-string secret is also inert (never a self-verified capability)', async () => {
    const other = await boot({ receiptSecret: '' });
    try {
      const r = await read(other.app, `rt=${mint(ORDER_ID)}`);
      expect(r.status).toBe(404);
    } finally {
      await other.app.close();
    }
  });
});

/**
 * Token-structure fuzz sweep (Phase 15 #2): session 132's proof-param
 * doctrine applied to `?rt=`. The pure oracle (`verifyReceiptAccessToken` —
 * the very function `findOneForViewer` runs) predicts each case and the
 * wire must agree, case by case, over the real ValidationPipe +
 * ErrorFormatFilter. This is the HONEST form of "every mutation denies":
 * probe-established truth (this session) is that Node's base64url decoder
 * is LENIENT — it skips non-alphabet characters, ignores trailing `=`
 * padding, and a 43-char signature carries TWO unused low bits in its
 * last char — so mutations producing an EQUIVALENT ENCODING of the same
 * digest bytes still verify. They grant no new capability (the attacker
 * needed a valid signature to reach that point at all), but a blanket
 * "all 404" claim would be false, so the seeded charset/char-flip families
 * pin AGREEMENT while the structurally-dead families (bit-flip re-encode,
 * truncation, segment swap, unresigned expiry tamper) pin ZERO unlocks.
 * Everything denied is the byte-identical canonical 404 and NOTHING 5xxes
 * through the real pipe+filter (session-84 doctrine). Deterministic seeds;
 * a FAIL prints its seed + case (session 84/132 idiom).
 */
const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const NUL_CH = String.fromCodePoint(0x0000);
const REPL_CH = String.fromCodePoint(0xfffd);
const LONE_HI = String.fromCodePoint(0xd800); // lone surrogate — encodeParam normalizes

/** What the server actually holds for an encodeParam-sent value (WHATWG replacement). */
const normWire = (v: string): string =>
  new TextDecoder().decode(new TextEncoder().encode(v));

/** Segment split at the LAST dot — mirrors the verifier's own rule. */
const splitTok = (t: string): [string, string] => {
  const i = t.lastIndexOf('.');
  return i < 0 ? [t, ''] : [t.slice(0, i), t.slice(i + 1)];
};

describe('GET /api/orders/:id?rt= — token-structure fuzz sweep (seeded)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    ({ app } = await boot({ receiptSecret: RECEIPT_TEST }));
  });
  afterAll(async () => { await app.close(); });

  /** Replay context on failure (session-132 fuzz idiom). */
  async function attempt(ctx: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (e: any) {
      throw new Error(`${ctx}\n  -> ${e?.message ?? e}`);
    }
  }

  async function sweep(
    family: string,
    seed: number,
    gen: (rng: Rng, base: string, foreign: string) => string,
    malleable: boolean, // false => structurally dead family: hard ZERO-unlock contract
  ): Promise<{ unlocked: number; denied: number }> {
    const rng = makeRng(seed);
    const base = mint(ORDER_ID); // 72h default TTL — no clock edge mid-sweep
    const foreign = mint(OTHER_ORDER_ID);
    let unlocked = 0;
    let denied = 0;
    for (let n = 0; n < 40; n++) {
      const mutated = gen(rng, base, foreign);
      const received = normWire(mutated); // the string the service will see
      const prediction = verifyReceiptAccessToken(received, ORDER_ID, RECEIPT_TEST);
      await attempt(
        `${family} seed=0x${(seed >>> 0).toString(16)} n=${n} got=${JSON.stringify(received.slice(0, 84))}`,
        async () => {
          const r = await read(app, `rt=${encodeParam(mutated)}`);
          expect(r.status).toBeLessThan(500); // never 5xx through the real pipe+filter
          expect(r.status).toBe(prediction ? 200 : 404); // wire === pure oracle
          if (!prediction) expect(r.raw).toBe(CANONICAL_404);
          else expect(JSON.parse(r.raw).code).toBe('FO-MAGIC');
        },
      );
      if (prediction) unlocked++; else denied++;
    }
    expect(denied).toBeGreaterThan(0); // every family overwhelmingly denies
    if (!malleable) expect(unlocked).toBe(0); // signature-first / no-dot shapes CANNOT live
    return { unlocked, denied };
  }

  const INJECT_POOL = [
    '+', '/', '=', '!', '~', ' ', '\n', '\t', '%', '&', '#', '.', '?', ':', '\\', '"', "'",
    '-', '_', 'A', 'z', '0', '9', NUL_CH, REPL_CH, LONE_HI,
  ];
  const EXP_JUNK = ['0', '-5', '-0', '999999999999999999999', '1e30', '0x10', '', ' ', 'abc', 'Infinity', 'NaN'];

  it('control: freshly minted UNmutated tokens always unlock', async () => {
    for (let i = 0; i < 3; i++) {
      const r = await read(app, `rt=${mint(ORDER_ID)}`);
      expect(r.status).toBe(200);
      expect(JSON.parse(r.raw).code).toBe('FO-MAGIC');
    }
  });

  it('charset family: 40 seeded hostile-char substitutions agree with the oracle', async () => {
    const { unlocked, denied } = await sweep('charset', 0x5EED01, (rng, base) => {
      let t = base;
      const edits = 1 + rng.int(3);
      for (let e = 0; e < edits; e++) {
        const i = rng.int(t.length);
        t = t.slice(0, i) + rng.pick(INJECT_POOL) + t.slice(i + 1);
      }
      return t;
    }, true);
    // Malleable classes can legitimately live (skipped-char injection into
    // the SIG only); substitutions overwhelmingly deny.
    expect(unlocked).toBeLessThan(denied);
  });

  it('charflip family: 40 seeded alphabet substitutions agree with the oracle', async () => {
    const { unlocked, denied } = await sweep('charflip', 0x5EED02, (rng, base) => {
      const [p, s] = splitTok(base);
      const usePayload = rng.int(2) === 0;
      const seg = usePayload ? p : s;
      // Half the cases deliberately hammer the LAST char — the 2-bit
      // malleability window on the signature side.
      const idx = rng.int(2) === 0 ? seg.length - 1 : rng.int(seg.length);
      const ch = rng.pick([...B64URL]);
      const m = seg.slice(0, idx) + ch + seg.slice(idx + 1);
      return usePayload ? `${m}.${s}` : `${p}.${m}`;
    }, true);
    expect(unlocked).toBeLessThan(denied);
  });

  it('bitflip family: 40 seeded single-bit flips (canonical re-encode) NEVER unlock', async () => {
    // A flip in BYTE space always changes the encoded payload text or the
    // digest itself — there is no no-op window in canonical re-encoding,
    // so this family is structurally dead against the signature-first check.
    await sweep('bitflip', 0x5EED03, (rng, base) => {
      const [p, s] = splitTok(base);
      const usePayload = rng.int(2) === 0;
      const seg = usePayload ? p : s;
      const buf = Buffer.from(seg, 'base64url');
      buf[rng.int(buf.length)] ^= 1 << rng.int(8);
      const m = buf.toString('base64url');
      return usePayload ? `${m}.${s}` : `${p}.${m}`;
    }, false);
  });

  it('truncate family: 40 seeded prefix/suffix/char-removal cuts NEVER unlock', async () => {
    await sweep('trunc', 0x5EED04, (rng, base) => {
      const k = rng.int(4);
      if (k === 0) return base.slice(0, 1 + rng.int(base.length - 1)); // >=1 char off the tail
      if (k === 1) return base.slice(rng.int(base.length - 1)); // >=1 char off the head
      if (k === 2) {
        const i = rng.int(base.length);
        return base.slice(0, i) + base.slice(i + 1); // one char removed anywhere
      }
      return base.replace('.', ''); // dot splice — the split guard's own class
    }, false);
  });

  it('segment-swap family: 40 seeded swaps and cross-cuts NEVER unlock', async () => {
    await sweep('swap', 0x5EED05, (rng, base, foreign) => {
      const [p, s] = splitTok(base);
      const [p2, s2] = splitTok(foreign);
      const k = rng.int(4);
      if (k === 0) return `${s}.${p}`; // full swap: 47-byte "digest" vs 32
      if (k === 1) return `${p}.${s2}`; // cut-and-paste foreign sig
      if (k === 2) return `${p2}.${s}`; // foreign payload, own sig
      return `${base}.${foreign}`; // JWT-shaped double dot
    }, false);
  });

  it('expiry-tamper family: 40 seeded UNRESIGNED exp rewrites NEVER unlock', async () => {
    // The signature check runs FIRST, so a tampered expiry never even
    // reaches the date comparison — the whole family dies on HMAC.
    await sweep('expiry', 0x5EED06, (rng, base) => {
      const [p, s] = splitTok(base);
      const text = Buffer.from(p, 'base64url').toString('utf8');
      const sep = text.lastIndexOf('|');
      return `${Buffer.from(text.slice(0, sep + 1) + rng.pick(EXP_JUNK), 'utf8').toString('base64url')}.${s}`;
    }, false);
  });

  it('pinned equivalence classes: same-DIGEST encodings VERIFY, payload-side never', async () => {
    const [p, s] = splitTok(mint(ORDER_ID));
    const mid = 10;
    // {value, mode, want} — mode 'raw' sends the query value VERBATIM
    // (the session-132 raw-plus trap rides this), 'enc' percent-encodes.
    const cases: Array<[string, 'raw' | 'enc', 200 | 404]> = [
      [`${p}.${s}=`, 'raw', 200], // trailing '=' padding ignored by the decoder
      [`${p}.${s}=`, 'enc', 200], // %3D lands as literal '=' — same lenient skip
      [`${p}.${s.slice(0, mid)}!${s.slice(mid)}`, 'enc', 200], // non-alphabet char skipped
      [`${p}.${s.slice(0, mid)} ${s.slice(mid)}`, 'enc', 200], // space skipped
      [`${p}.${s.slice(0, mid)}${NUL_CH}${s.slice(mid)}`, 'enc', 200], // NUL skipped (raw NUL paths are refused CLIENT-side — probe truth)
      [`${p}.${s}\n`, 'enc', 200], // trailing newline skipped
      [`${p}.${s.slice(0, mid)}=${s.slice(mid)}`, 'enc', 404], // MIDDLE '=' stops the decoder -> short digest
      [`${p}.${s.slice(0, mid)}.${s.slice(mid)}`, 'enc', 404], // '.' shifts the lastIndexOf split
      [`${p.slice(0, mid)}!${p.slice(mid)}.${s}`, 'enc', 404], // payload side: HMAC runs over the RAW string
      [`${p}.${s}+`, 'raw', 200], // wire '+' -> space -> skipped -> identical 32 bytes
      [`${p}.${s}%2B`, 'raw', 404], // literal '+' decodes as VALUE 62 -> 33 bytes -> length veto
    ];
    for (const [value, mode, want] of cases) {
      const qs = mode === 'raw' ? `rt=${value}` : `rt=${encodeURIComponent(value)}`;
      const r = await read(app, qs);
      expect([value, mode, r.status]).toEqual([value, mode, want]);
      if (want === 404) expect(r.raw).toBe(CANONICAL_404);
    }
  });

  it('pinned: the last signature char carries TWO unused bits — 1/4 of the alphabet re-verifies', async () => {
    const [p, s] = splitTok(mint(ORDER_ID));
    const digest = Buffer.from(s, 'base64url');
    const equiv = [...B64URL].filter((ch) => {
      const d = Buffer.from(s.slice(0, -1) + ch, 'base64url');
      return d.length === 32 && Buffer.compare(d, digest) === 0;
    });
    expect(equiv).toContain(s[s.length - 1]);
    expect(equiv.length).toBe(4); // 43 chars x 6 bits = 258 vs a 256-bit digest
    for (const ch of equiv) {
      const r = await read(app, `rt=${p}.${s.slice(0, -1)}${ch}`);
      expect(r.status).toBe(200); // equivalent ENCODING of the same bytes
    }
    let checked = 0;
    for (const ch of [...B64URL]) {
      if (equiv.includes(ch)) continue;
      const r = await read(app, `rt=${p}.${s.slice(0, -1)}${ch}`);
      expect(r.status).toBe(404);
      expect(r.raw).toBe(CANONICAL_404);
      checked++;
    }
    expect(checked).toBe(60);
  });

  it('pinned dot-boundary shapes deny byte-identically (split-guard ladder)', async () => {
    const tok = mint(ORDER_ID);
    const [p, s] = splitTok(tok);
    for (const value of ['.', `${tok}.`, `.${tok}`, `${p}..${s}`, p, s, `${p}.${s}.`]) {
      const r = await read(app, `rt=${encodeURIComponent(value)}`);
      expect(r.status).toBe(404);
      expect(r.raw).toBe(CANONICAL_404);
    }
  });

  it('pinned: the 4096 length guard is WIRE-INVISIBLE — 4096 and 4097 deny identically', async () => {
    const tok = mint(ORDER_ID);
    const at = tok + 'A'.repeat(MAX_RECEIPT_TOKEN_LEN - tok.length);
    const over = `${at}A`;
    expect(at.length).toBe(MAX_RECEIPT_TOKEN_LEN);
    expect(over.length).toBe(MAX_RECEIPT_TOKEN_LEN + 1);
    for (const value of [at, over]) {
      const r = await read(app, `rt=${value}`);
      expect(r.status).toBe(404);
      expect(r.raw).toBe(CANONICAL_404); // guard-deny vs HMAC-deny are indistinguishable — no oracle
    }
  });

  it('pinned: expiry is CLOCK-bound, not issuance-bound (future-mint lives, past-mint denies)', async () => {
    const future = issueReceiptAccessToken(ORDER_ID, RECEIPT_TEST, 3600, Date.now() + 24 * 60 * 60 * 1000);
    expect((await read(app, `rt=${future}`)).status).toBe(200); // secret-holder knob, honestly valid
    const past = issueReceiptAccessToken(ORDER_ID, RECEIPT_TEST, 1, Date.now() - 60_000);
    const r = await read(app, `rt=${past}`);
    expect(r.status).toBe(404);
    expect(r.raw).toBe(CANONICAL_404);
  });
});
