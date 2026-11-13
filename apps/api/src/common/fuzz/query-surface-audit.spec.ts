import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

/**
 * QUERY-SURFACE SANITIZER SWEEP (session 87, Phase 8 test loop).
 *
 * Pins the roadmap contract "no controller takes an unsanitized public
 * string to the driver" mechanically:
 *
 *  1. DISCOVER — every `@Query` parameter site in every controller under
 *     src/ (TypeScript AST, not grep), so a FUTURE route with a query
 *     string fails this spec until it is registered with a disposition.
 *  2. MATCH — each discovered site must equal its registry entry exactly
 *     (param literal, DTO type), and each registry entry must still exist
 *     (a deleted site may not leave its claim behind).
 *  3. EVIDENCE — every disposition carries at least one executable check,
 *     never a comment: a regex probe on the SERVICE source (the sanitizer
 *     / clamp idiom actually guards this param), or the class-validator
 *     completeness walk on the DTO that fronts it, or the documented
 *     in-memory guard before any SQL.
 *
 * Where the guard lives per route family (session 84's contract carried to
 * the remaining surfaces by this sweep):
 *  - `GET /restaurants`            raw text → sanitizeQueryText at the service
 *  - `GET /api/search`             DTO @Transform strips BEFORE the pipe
 *  - `GET /restaurants/:id/reviews` raw numbers → clampToIntRange at the service
 *  - order/promo lists             DTO-validated + closed-range clamp in service
 *  - `?contactEmail=` (guest proof) compared in JS memory — NEVER a SQL predicate
 *  - `?status=` (admin force)      STATUS_FLOW allowlist checked before any write
 */

const SRC = path.resolve(__dirname, '../..');

interface QuerySite {
  key: string; // ClassName.method
  file: string; // repo-relative
  params: { literal: string | null; dto: string | null }[];
}

function walkControllers(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'dist') continue;
      walkControllers(p, out);
    } else if (e.name.endsWith('.controller.ts')) out.push(p);
  }
  return out;
}

function discoverQuerySites(): QuerySite[] {
  const sites: QuerySite[] = [];
  for (const file of walkControllers(SRC)) {
    const src = ts.createSourceFile(
      file,
      fs.readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const rel = path.relative(SRC, file).replace(/\\/g, '/');
    src.statements.forEach((st) => {
      if (!ts.isClassDeclaration(st) || !st.name) return;
      st.members.forEach((m) => {
        if (!ts.isMethodDeclaration(m) || !m.name) return;
        const params: QuerySite['params'] = [];
        m.parameters.forEach((p) => {
          (p.modifiers || [])
            .filter(ts.isDecorator)
            .forEach((d) => {
              const ex = d.expression;
              if (
                ts.isCallExpression(ex) &&
                ts.isIdentifier(ex.expression) &&
                ex.expression.getText() === 'Query'
              ) {
                const literal = ex.arguments.length
                  ? ex.arguments[0].getText().replace(/^['"]|['"]$/g, '')
                  : null;
                const dto =
                  literal === null && p.type ? p.type.getText() : null;
                params.push({ literal, dto });
              }
            });
        });
        if (params.length) {
          sites.push({ key: `${st.name.getText()}.${m.name.getText()}`, file: rel, params });
        }
      });
    });
  }
  return sites.sort((a, b) => a.key.localeCompare(b.key));
}

// ------------------------------------------------------------ registry ----

interface RegistryEntry {
  params: { literal: string | null; dto: string | null }[];
  /** One-line honest label for the report — never a guard itself. */
  disposition: string;
  /** At least one executable check per site — comments do not count. */
  checks: Check[];
}

type Check =
  /** file must match every regex (dotall); message names the guard. */
  | { kind: 'must'; file: string; regexes: [string, string][] }
  /** file must NOT match (the dangerous shape is absent). */
  | { kind: 'forbid'; file: string; regexes: [string, string][] }
  /** file must match the regex EXACTLY `times` times. */
  | { kind: 'count'; file: string; regex: string; times: number; why: string }
  /** every property of the DTO class carries a class-validator decorator. */
  | { kind: 'dto-validated'; file: string; className: string };

const RESTAURANTS_SVC = 'restaurants/restaurants.service.ts';
const REVIEWS_SVC = 'reviews/reviews.service.ts';
const ORDERS_SVC = 'orders/orders.service.ts';
const PROMOS_SVC = 'promos/promos.service.ts';
const SEARCH_SVC = 'search/search.service.ts';

/**
 * The registered surfaces. `params` mirrors the exact @Query literals /
 * DTO types the AST finds, so an accidental param rename trips the spec.
 */
const REGISTRY: Record<string, RegistryEntry> = {
  // Public storefront list — RAW params, no DTO. Session 84 guarded the
  // text trio; session 87 folded the same helpers in from common/int-range.
  'RestaurantsController.list': {
    params: [
      { literal: 'search', dto: null },
      { literal: 'cuisine', dto: null },
      { literal: 'city', dto: null },
      { literal: 'sort', dto: null },
      { literal: 'page', dto: null },
      { literal: 'limit', dto: null },
    ],
    disposition: 'raw text/enum/numeric — sanitized + clamped AT THE SERVICE',
    checks: [
      {
        kind: 'must',
        file: RESTAURANTS_SVC,
        regexes: [
          ['sanitizeQueryText\\(q\\.search\\)', 'NUL class (22021) dies before SQL'],
          ['sanitizeQueryText\\(q\\.cuisine\\)', 'NUL class (22021) dies before SQL'],
          ['sanitizeQueryText\\(q\\.city\\)', 'NUL class (22021) dies before SQL'],
          ['clampToIntRange\\(\\s*blankToUndefined\\(q\\.page\\)', 'OFFSET stays bigint-legal'],
          ['clampToIntRange\\(\\s*blankToUndefined\\(q\\.limit\\)', 'LIMIT stays a closed int'],
          ['switch \\(q\\.sort\\)', 'sort lands on the ORDER BY whitelist'],
        ],
      },
    ],
  },

  // Public unified search — sanitizer runs in the DTO Transform BEFORE the
  // pipe, so the service is only ever handed legal codepoints.
  'SearchController.search': {
    params: [{ literal: null, dto: 'SearchQueryDto' }],
    disposition: 'DTO @Transform(sanitizeQueryText) + class-validator completeness',
    checks: [
      {
        kind: 'must',
        file: 'search/dto/search-query.dto.ts',
        regexes: [['sanitizeQueryText', 'the Transform strips NUL/surrogates at the pipe']],
      },
      { kind: 'dto-validated', file: 'search/dto/search-query.dto.ts', className: 'SearchQueryDto' },
      {
        kind: 'must',
        file: SEARCH_SVC,
        regexes: [['sanitizeQueryText\\(q\\)', 'defense in depth at the service too']],
      },
    ],
  },

  // Public review feed — the session 87 fix: raw page/limit used to bind
  // `1e30` straight into OFFSET (driver 22001 → 500 on a public GET).
  'RestaurantReviewsController.list': {
    params: [
      { literal: 'page', dto: null },
      { literal: 'limit', dto: null },
    ],
    disposition: 'raw numeric — clampToIntRange AT THE SERVICE (session 87 sweep)',
    checks: [
      {
        kind: 'must',
        file: REVIEWS_SVC,
        regexes: [
          ['clampToIntRange\\(\\s*blankToUndefined\\(page\\)', 'OFFSET stays bigint-legal'],
          ['clampToIntRange\\(\\s*blankToUndefined\\(limit\\)', 'LIMIT stays a closed int'],
        ],
      },
    ],
  },

  // Order lists — DTO-validated shape, closed-range clamp survives DIRECT
  // service calls (the session 84 precedent for routes with a pipe in front).
  'OrdersController.my': {
    params: [{ literal: null, dto: 'ListMyOrdersDto' }],
    disposition: 'ListMyOrdersDto completeness + service-level closed-range clamp',
    checks: [
      { kind: 'dto-validated', file: 'orders/dto/list-my-orders.dto.ts', className: 'ListMyOrdersDto' },
      {
        kind: 'count',
        file: ORDERS_SVC,
        regex: 'clampToIntRange\\(q\\.page, 1, MAX_PUBLIC_PAGE, 1\\)',
        times: 3,
        why: 'findMine + findForDriver + findForRestaurant all clamp',
      },
      {
        kind: 'count',
        file: ORDERS_SVC,
        regex: 'clampToIntRange\\(q\\.limit, 1, MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE\\)',
        times: 3,
        why: 'LIMIT bound mirrors the DTO @Max(MAX_PAGE_SIZE)',
      },
    ],
  },
  'RestaurantOrdersController.list': {
    params: [{ literal: null, dto: 'ListMyOrdersDto' }],
    disposition: 'same ListMyOrdersDto + orders.service clamp (findForRestaurant)',
    checks: [
      { kind: 'dto-validated', file: 'orders/dto/list-my-orders.dto.ts', className: 'ListMyOrdersDto' },
    ],
  },
  'DriverOrdersController.list': {
    params: [{ literal: null, dto: 'ListMyOrdersDto' }],
    disposition: 'same ListMyOrdersDto + orders.service clamp (findForDriver)',
    checks: [
      { kind: 'dto-validated', file: 'orders/dto/list-my-orders.dto.ts', className: 'ListMyOrdersDto' },
    ],
  },

  // Guest receipt proof — the string is NEVER a SQL predicate: it is
  // normalized and compared in JS memory against the loaded row, so even a
  // NUL byte can only answer 404, never reach the driver.
  'OrdersController.one': {
    params: [{ literal: 'contactEmail', dto: null }],
    disposition: 'in-memory proof comparison — never bound into SQL',
    checks: [
      {
        kind: 'must',
        file: ORDERS_SVC,
        regexes: [
          ['normalizeContactEmail\\(contactEmail\\)', 'trim+lowercase before compare'],
          ['proof === order\\.contactEmail', 'the compare happens in JS memory'],
        ],
      },
      {
        kind: 'forbid',
        file: ORDERS_SVC,
        regexes: [
          ['where:[^\\n]*contactEmail', 'proof must NEVER become a SQL predicate'],
          ['findBy\\([^)]*contactEmail', 'proof must NEVER become a SQL predicate'],
        ],
      },
    ],
  },

  // Admin force-transition — RAW enum query param, but STATUS_FLOW is an
  // in-memory allowlist consulted BEFORE any write, so junk answers 400.
  'OrdersController.updateStatus': {
    params: [{ literal: 'status', dto: null }],
    disposition: 'STATUS_FLOW allowlist checked in memory before any write',
    checks: [
      {
        kind: 'count',
        file: ORDERS_SVC,
        regex: 'if \\(!STATUS_FLOW\\[order\\.status\\]\\.includes\\(status\\)\\)',
        times: 2,
        why: 'owner portal + admin backdoor consult the same allowlist',
      },
    ],
  },

  // Owner/driver portal status routes — status arrives via query OBJECT
  // fronted by SetOrderStatusDto (@IsEnum at the pipe) + in-service guards.
  'RestaurantOrdersController.setStatus': {
    params: [{ literal: null, dto: 'SetOrderStatusDto' }],
    disposition: 'SetOrderStatusDto @IsEnum at the pipe + STATUS_FLOW before write',
    checks: [
      { kind: 'dto-validated', file: 'orders/dto/set-order-status.dto.ts', className: 'SetOrderStatusDto' },
    ],
  },
  'DriverOrdersController.setStatus': {
    params: [{ literal: null, dto: 'SetOrderStatusDto' }],
    disposition: 'SetOrderStatusDto @IsEnum at the pipe + in-memory transition check',
    checks: [
      { kind: 'dto-validated', file: 'orders/dto/set-order-status.dto.ts', className: 'SetOrderStatusDto' },
      {
        kind: 'must',
        file: ORDERS_SVC,
        regexes: [['const allowed =\\s*\\(order\\.status === OrderStatus\\.PREPARING', 'driver transitions allowlisted in memory']],
      },
    ],
  },

  // Admin promo ledger — DTO completeness + the session 87 clamp
  // (page had NO bound at all: `?page=1e30` passed IsInt+Min → OFFSET 500).
  'PromosAdminController.usages': {
    params: [{ literal: null, dto: 'ListPromoUsagesDto' }],
    disposition: 'ListPromoUsagesDto completeness + service-level closed-range clamp',
    checks: [
      { kind: 'dto-validated', file: 'promos/dto/admin-promo.dto.ts', className: 'ListPromoUsagesDto' },
      {
        kind: 'count',
        file: PROMOS_SVC,
        regex: 'clampToIntRange\\(query\\.page, 1, MAX_PUBLIC_PAGE, DEFAULT_PAGE\\)',
        times: 1,
        why: 'listUsages OFFSET stays bigint-legal',
      },
    ],
  },
};

// ------------------------------------------------------------- checks ----

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(SRC, rel), 'utf8');
}

/** class-validator completeness: every DTO property carries a decorator
 * actually imported from 'class-validator' (the whitelist:true contract). */
function assertDtoValidated(file: string, className: string): void {
  const src = readSrc(file);
  const ast = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
  const cvNames = new Set<string>();
  ast.statements.forEach((st) => {
    if (
      ts.isImportDeclaration(st) &&
      ts.isStringLiteral(st.moduleSpecifier) &&
      st.moduleSpecifier.text === 'class-validator' &&
      st.importClause?.namedBindings &&
      ts.isNamedImports(st.importClause.namedBindings)
    ) {
      st.importClause.namedBindings.elements.forEach((e) => cvNames.add(e.name.getText()));
    }
  });
  const cls = ast.statements.find(
    (st): st is ts.ClassDeclaration =>
      ts.isClassDeclaration(st) && st.name?.getText() === className,
  );
  if (!cls) throw new Error(`${className} not found in ${file}`);
  const offenders: string[] = [];
  cls.members.forEach((m) => {
    if (!ts.isPropertyDeclaration(m) || !m.name) return;
    const decorators = (m.modifiers || []).filter(ts.isDecorator);
    const hasValidator = decorators.some((d) => {
      const ex = d.expression;
      const name = ts.isCallExpression(ex)
        ? ex.expression.getText()
        : ts.isIdentifier(ex)
          ? ex.getText()
          : '';
      return cvNames.has(name);
    });
    if (!hasValidator) offenders.push(m.name.getText());
  });
  if (offenders.length) {
    throw new Error(
      `${className}: property/ies without a class-validator decorator ` +
        `(whitelist:true would strip them): ${offenders.join(', ')}`,
    );
  }
}

function runCheck(entry: string, check: Check): string[] {
  const failures: string[] = [];
  if (check.kind === 'dto-validated') {
    try {
      assertDtoValidated(check.file, check.className);
    } catch (e: any) {
      failures.push(`${entry}: ${e.message}`);
    }
    return failures;
  }
  const content = readSrc(check.file);
  if (check.kind === 'must') {
    for (const [pattern, why] of check.regexes) {
      if (!new RegExp(pattern, 's').test(content)) {
        failures.push(`${entry}: ${check.file} lacks /${pattern}/ (${why})`);
      }
    }
  } else if (check.kind === 'forbid') {
    for (const [pattern, why] of check.regexes) {
      if (new RegExp(pattern, 's').test(content)) {
        failures.push(`${entry}: ${check.file} matches forbidden /${pattern}/ (${why})`);
      }
    }
  } else {
    const matches = content.match(new RegExp(check.regex, 'g')) || [];
    if (matches.length !== check.times) {
      failures.push(
        `${entry}: ${check.file} /${check.regex}/ ×${check.times} (${check.why}) — found ${matches.length}`,
      );
    }
  }
  return failures;
}

describe('query-surface sanitizer sweep (static gate)', () => {
  const sites = discoverQuerySites();

  it('every controller @Query site is registered, and the registry holds no ghosts', () => {
    const found = sites.map((s) => s.key).sort();
    const registered = Object.keys(REGISTRY).sort();
    const missing = found.filter((k) => !REGISTRY[k]);
    const ghosts = registered.filter((k) => !found.includes(k));
    expect(
      missing.length
        ? `UNREGISTERED @Query sites (audit + register them): ${missing.join(', ')}`
        : '',
    ).toBe('');
    expect(
      ghosts.length ? `STALE registry entries (site is gone): ${ghosts.join(', ')}` : '',
    ).toBe('');
    expect(found).toEqual(registered);
    expect(found.length).toBeGreaterThan(0);
  });

  it('each site keeps its exact param literals / DTO types (renames trip the gate)', () => {
    const problems: string[] = [];
    for (const site of sites) {
      const entry = REGISTRY[site.key];
      if (!entry) continue; // reported by the discovery test
      if (JSON.stringify(site.params) !== JSON.stringify(entry.params)) {
        problems.push(
          `${site.key}: AST ${JSON.stringify(site.params)} ≠ registry ${JSON.stringify(entry.params)} (${site.file})`,
        );
      }
    }
    expect(problems).toEqual([]);
  });

  it('every disposition is backed by executable source evidence', () => {
    const failures: string[] = [];
    for (const [entry, def] of Object.entries(REGISTRY)) {
      if (!def.checks.length) failures.push(`${entry}: registered but carries NO checks`);
      for (const check of def.checks) failures.push(...runCheck(entry, check));
    }
    expect(failures).toEqual([]);
  });

  it('the sweep is complete over the text surfaces: every raw string @Query literal is guarded at its service', () => {
    // Defense against "registered but wrong": a param the controller hands
    // over RAW as a string must be either sanitized/clamped by the service
    // it is forwarded to, or compared in memory only. The registry checks
    // above encode exactly which; this pins that no NEW raw-literal site
    // sneaks in outside the guarded set.
    const rawStringSites = sites
      .flatMap((s) => s.params.map((p) => ({ ...p, key: s.key })))
      .filter((p) => p.literal !== null);
    const guarded = new Set([
      'search', 'cuisine', 'city', // sanitizeQueryText at restaurants.service
      'sort', 'status', // in-memory allowlists (switch / STATUS_FLOW)
      'page', 'limit', // clampToIntRange at the services
      'contactEmail', // in-memory proof comparison only
    ]);
    const unguarded = rawStringSites.filter((p) => !guarded.has(p.literal as string));
    expect(unguarded.map((p) => `${p.key}?${p.literal}`)).toEqual([]);
  });
});
