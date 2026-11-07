import { BadRequestException, ValidationPipe } from '@nestjs/common';
import {
  RestaurantHourDto,
  UpdateRestaurantHoursDto,
} from './restaurant-hours.dto';

/** Same options the app boots with (src/main.ts) — this tests real stripping. */
const pipe = new ValidationPipe({ whitelist: true, transform: true, forbidUnknownValues: true });
const check = (dto: any, value: any) =>
  pipe.transform(value, { metatype: dto, type: 'body' });

describe('Restaurant hours DTOs — validation via global ValidationPipe', () => {
  const days = [{ dayOfWeek: 1, opensAt: '08:00', closesAt: '22:00' }];

  it('accepts the minimal payload and instantiates the nested rows', async () => {
    const out: any = await check(UpdateRestaurantHoursDto, { days });
    expect(out).toBeInstanceOf(UpdateRestaurantHoursDto);
    expect(out.days).toHaveLength(1);
    expect(out.days[0]).toBeInstanceOf(RestaurantHourDto);
    expect(out.days[0].dayOfWeek).toBe(1);
  });

  it('requires `days`', async () => {
    await expect(check(UpdateRestaurantHoursDto, {})).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('accepts an explicit empty schedule (clear + fallback) and explicit-null zone', async () => {
    const out: any = await check(UpdateRestaurantHoursDto, {
      days: [],
      timeZone: null,
    });
    expect(out.days).toEqual([]);
    expect(out.timeZone).toBeNull();
  });

  it('rejects out-of-range weekdays and malformed times', async () => {
    for (const bad of [
      [{ dayOfWeek: 7, opensAt: '08:00', closesAt: '22:00' }],
      [{ dayOfWeek: -1, opensAt: '08:00', closesAt: '22:00' }],
      [{ dayOfWeek: '1', opensAt: '08:00', closesAt: '22:00' }],
      [{ dayOfWeek: 1, opensAt: '8:00', closesAt: '22:00' }],
      [{ dayOfWeek: 1, opensAt: '08:00', closesAt: '24:00' }],
      [{ dayOfWeek: 1, opensAt: '08:00' }],
    ]) {
      await expect(
        check(UpdateRestaurantHoursDto, { days: bad }),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
  });

  it('rejects schedules longer than a week and unknown extra props', async () => {
    await expect(
      check(UpdateRestaurantHoursDto, {
        days: Array.from({ length: 8 }, (_, i) => ({
          dayOfWeek: i,
          opensAt: '08:00',
          closesAt: '22:00',
        })),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    const out: any = await check(UpdateRestaurantHoursDto, {
      days,
      evil: 'x',
    });
    expect(out.evil).toBeUndefined();
  });
});
