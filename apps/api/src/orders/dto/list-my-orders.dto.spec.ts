import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { ListMyOrdersDto } from './list-my-orders.dto';

/** Same options the app boots with (src/main.ts) — this tests real coercion + stripping. */
const pipe = new ValidationPipe({ whitelist: true, transform: true, forbidUnknownValues: true });
const check = (value: any) =>
  pipe.transform(value, { metatype: ListMyOrdersDto, type: 'query' });

describe('ListMyOrdersDto — query validation via global ValidationPipe', () => {
  it('accepts an empty query (all filters optional)', async () => {
    const out: any = await check({});
    expect(out).toBeInstanceOf(ListMyOrdersDto);
    expect(out.status).toBeUndefined();
    expect(out.page).toBeUndefined();
    expect(out.limit).toBeUndefined();
  });

  it('accepts every valid status value', async () => {
    for (const status of ['pending', 'confirmed', 'preparing', 'delivering', 'completed', 'cancelled']) {
      const out: any = await check({ status });
      expect(out.status).toBe(status);
    }
  });

  it('coerces stringified page/limit from the query string to numbers', async () => {
    const out: any = await check({ page: '3', limit: '10' });
    expect(out.page).toBe(3);
    expect(out.limit).toBe(10);
  });

  it('rejects unknown status values', async () => {
    for (const status of ['shipped', 'PENDING', '', 'cancel']) {
      await expect(check({ status })).rejects.toBeInstanceOf(BadRequestException);
    }
  });

  it('rejects non-numeric, zero, negative and fractional page/limit', async () => {
    for (const page of ['abc', '0', '-1', '1.5']) {
      await expect(check({ page })).rejects.toBeInstanceOf(BadRequestException);
    }
    for (const limit of ['x', '0', '-5', '51', '2.5']) {
      await expect(check({ limit })).rejects.toBeInstanceOf(BadRequestException);
    }
  });

  it('strips unknown properties (whitelist) — nothing injectable via query', async () => {
    const out: any = await check({
      status: 'pending',
      userId: 'someone-else',
      restaurantId: 'r1',
      sort: 'createdAt',
    });
    expect(out.status).toBe('pending');
    expect(out.userId).toBeUndefined();
    expect(out.restaurantId).toBeUndefined();
    expect(out.sort).toBeUndefined();
  });
});
