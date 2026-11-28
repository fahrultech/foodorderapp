import { BadRequestException } from '@nestjs/common';
import { Between, FindOperator, LessThanOrEqual, MoreThanOrEqual } from 'typeorm';

/**
 * Pure from/to resolver for the order-history date-range filter
 * (Phase 17 UX item). The DTO already rejects non-ISO-8601 shapes at the
 * pipe; this helper is the SECOND rung that direct service callers ride,
 * and the single place the CLOSED-range rule (from <= to) lives: an
 * inverted range 400s with the specific message, and a blank/whitespace
 * bound means UNSET (blankToUndefined doctrine), never an epoch sweep.
 *
 * DI-free by design (session 122/133 pattern): unit-specable and AST-
 * referenceable by the query-surface audit registry.
 */
export interface ListDateRange {
  from?: Date;
  to?: Date;
}

export function parseListDateRange(q: {
  from?: string;
  to?: string;
}): ListDateRange {
  const from = toBound(q.from, 'from');
  const to = toBound(q.to, 'to');
  if (from && to && from.getTime() > to.getTime()) {
    throw new BadRequestException('from must not be after to');
  }
  return { from, to };
}

function toBound(raw: string | undefined, name: 'from' | 'to'): Date | undefined {
  if (raw === undefined || raw === null) return undefined;
  const s = String(raw).trim();
  if (s === '') return undefined;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) {
    throw new BadRequestException(`${name} must be an ISO-8601 date or datetime`);
  }
  return d;
}

/**
 * CLOSED operator set for the range dialect: exactly three shapes can
 * ever be minted, so the COUNT translation in orders.service can
 * enumerate them (anything else is a programming error, surfaced loudly
 * rather than silently widening the total).
 */
export type DateRangeOperatorType = 'between' | 'moreThanOrEqual' | 'lessThanOrEqual';

/**
 * Translates the resolved bounds into the ONE TypeORM operator BOTH the
 * paged `find` and the join-free COUNT QB consume (no drift between the
 * page and its total). Undefined when no bound was sent: the where clause
 * then stays byte-identical to the pre-filter path.
 */
export function dateRangeOperator(range: ListDateRange): FindOperator<Date> | undefined {
  const { from, to } = range;
  if (from && to) return Between(from, to);
  if (from) return MoreThanOrEqual(from);
  if (to) return LessThanOrEqual(to);
  return undefined;
}

/** Decomposes a dateRangeOperator (or any row-loaded operator of the
 *  closed set) back into its SQL-bound bounds for the COUNT translation. */
export function dateRangeBounds(op: FindOperator<Date>): {
  type: DateRangeOperatorType;
  from?: Date;
  to?: Date;
} {
  // typeorm 0.3.31: `type` is a GETTER (older 0.3 builds had getType());
  // `value` is typed T so `Between`'s pair needs the unknown hop.
  const type = op.type as DateRangeOperatorType;
  if (type === 'between') {
    const [lo, hi] = op.value as unknown as [Date, Date];
    return { type, from: lo, to: hi };
  }
  if (type === 'moreThanOrEqual') return { type, from: op.value as Date };
  if (type === 'lessThanOrEqual') return { type, to: op.value as Date };
  throw new Error(`unsupported date-range operator '${type}' (closed set: between/moreThanOrEqual/lessThanOrEqual)`);
}
