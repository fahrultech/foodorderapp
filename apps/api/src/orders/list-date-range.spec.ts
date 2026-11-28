import { BadRequestException } from '@nestjs/common';
import { Between, FindOperator, LessThanOrEqual, MoreThan, MoreThanOrEqual } from 'typeorm';
import {
  dateRangeBounds,
  dateRangeOperator,
  parseListDateRange,
} from './list-date-range';

/**
 * Phase 17 order-history date-range filter: the pure bounds resolver the
 * service consults BEFORE building any where clause. Pins the closed-range
 * rule, the blank-means-unset doctrine and the emitted FindOptionsWhere
 * dialect (both the page find and the join-free COUNT consume it).
 */

const T2026_11_01 = Date.UTC(2026, 10, 1);
const T2026_11_15 = Date.UTC(2026, 10, 15);

describe('parseListDateRange', () => {
  it('parses full ISO datetimes to Date bounds', () => {
    const out = parseListDateRange({
      from: '2026-11-01T00:00:00.000Z',
      to: '2026-11-15T23:59:59.999Z',
    });
    expect(out.from!.getTime()).toBe(T2026_11_01);
    expect(out.to!.getTime()).toBe(Date.UTC(2026, 10, 15, 23, 59, 59, 999));
  });

  it('accepts date-only forms (UTC midnight semantics straight off the parse)', () => {
    const out = parseListDateRange({ from: '2026-11-01', to: '2026-11-15' });
    expect(out.from!.getTime()).toBe(T2026_11_01);
    expect(out.to!.getTime()).toBe(T2026_11_15);
  });

  it('accepts offset-bearing datetimes (folded to UTC)', () => {
    const out = parseListDateRange({ from: '2026-11-01T07:00:00+07:00' });
    expect(out.from!.getTime()).toBe(T2026_11_01);
  });

  it('single-sided ranges resolve the other bound to undefined', () => {
    expect(parseListDateRange({ from: '2026-11-01' })).toEqual({
      from: new Date(T2026_11_01),
      to: undefined,
    });
    expect(parseListDateRange({ to: '2026-11-15' })).toEqual({
      from: undefined,
      to: new Date(T2026_11_15),
    });
  });

  it('absent params resolve to no bounds at all', () => {
    expect(parseListDateRange({})).toEqual({ from: undefined, to: undefined });
  });

  it('blank / whitespace bounds mean UNSET, not the epoch (blankToUndefined doctrine)', () => {
    expect(parseListDateRange({ from: '', to: '   ' })).toEqual({
      from: undefined,
      to: undefined,
    });
  });

  it('junk strings 400 with the field named (direct-caller defense behind the DTO pipe)', () => {
    expect(() => parseListDateRange({ from: 'yesterday' })).toThrow(BadRequestException);
    try {
      parseListDateRange({ to: '15/11/2026' });
      fail('expected throw');
    } catch (e) {
      expect((e as BadRequestException).message).toBe(
        'to must be an ISO-8601 date or datetime',
      );
    }
  });

  it('an INVERTED range 400s with the specific closed-range message', () => {
    try {
      parseListDateRange({ from: '2026-11-15', to: '2026-11-01' });
      fail('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(BadRequestException);
      expect((e as BadRequestException).message).toBe('from must not be after to');
    }
  });

  it('from === to is a legal degenerate closed range', () => {
    const out = parseListDateRange({ from: '2026-11-01', to: '2026-11-01' });
    expect(out.from!.getTime()).toBe(out.to!.getTime());
  });
});

describe('dateRangeOperator + dateRangeBounds (the ONE dialect page and COUNT share)', () => {
  it('no bounds -> no operator at all (where stays byte-identical)', () => {
    expect(dateRangeOperator(parseListDateRange({}))).toBeUndefined();
    expect(dateRangeOperator(parseListDateRange({ from: '', to: undefined }))).toBeUndefined();
  });

  it('closed-set shapes: between / moreThanOrEqual / lessThanOrEqual', () => {
    const both = dateRangeOperator({ from: new Date(T2026_11_01), to: new Date(T2026_11_15) })!;
    expect(both).toBeInstanceOf(FindOperator);
    expect(dateRangeBounds(both)).toEqual({
      type: 'between',
      from: new Date(T2026_11_01),
      to: new Date(T2026_11_15),
    });
    expect(dateRangeBounds(MoreThanOrEqual(new Date(T2026_11_01)))).toEqual({
      type: 'moreThanOrEqual',
      from: new Date(T2026_11_01),
      to: undefined,
    });
    expect(dateRangeBounds(LessThanOrEqual(new Date(T2026_11_15)))).toEqual({
      type: 'lessThanOrEqual',
      from: undefined,
      to: new Date(T2026_11_15),
    });
    // The helpers and the raw TypeORM builders are the same operator.
    expect(dateRangeBounds(Between(new Date(T2026_11_01), new Date(T2026_11_15)))).toEqual({
      type: 'between',
      from: new Date(T2026_11_01),
      to: new Date(T2026_11_15),
    });
  });

  it('an operator OUTSIDE the closed set throws loudly instead of widening the total', () => {
    expect(() => dateRangeBounds(MoreThan(new Date(T2026_11_01)))).toThrow(
      /unsupported date-range operator/,
    );
  });
});
