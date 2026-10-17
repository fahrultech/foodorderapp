import { BadRequestException, ValidationPipe } from '@nestjs/common';
import {
  CreateMenuItemDto,
  UpdateAvailabilityDto,
  UpdateMenuItemDto,
} from './menu-item.dto';

/** Same options the app boots with (src/main.ts) — this tests real stripping. */
const pipe = new ValidationPipe({ whitelist: true, transform: true, forbidUnknownValues: true });
const check = (dto: any, value: any) =>
  pipe.transform(value, { metatype: dto, type: 'body' });

describe('Menu item DTOs — validation via global ValidationPipe', () => {
  const valid = { name: 'Sate Ayam', priceCents: 3500 };

  describe('CreateMenuItemDto', () => {
    it('accepts a minimal valid payload and instantiates the DTO', async () => {
      const out: any = await check(CreateMenuItemDto, { ...valid });
      expect(out).toBeInstanceOf(CreateMenuItemDto);
      expect(out.name).toBe('Sate Ayam');
      expect(out.priceCents).toBe(3500);
    });

    it('rejects missing name / missing priceCents', async () => {
      await expect(check(CreateMenuItemDto, { priceCents: 100 })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(check(CreateMenuItemDto, { name: 'No Price' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('rejects non-positive, huge, fractional and string prices', async () => {
      for (const priceCents of [0, -100, 10000001, 15.5, '1500']) {
        await expect(
          check(CreateMenuItemDto, { ...valid, priceCents }),
        ).rejects.toBeInstanceOf(BadRequestException);
      }
    });

    it('rejects blank, over-long and non-boolean/oversized fields', async () => {
      await expect(check(CreateMenuItemDto, { ...valid, name: '   ' })).rejects.toBeInstanceOf(
        BadRequestException,
      ); // rejected via @Matches(/\S/) — IsNotEmpty alone would let it through
      await expect(
        check(CreateMenuItemDto, { ...valid, name: 'x'.repeat(121) }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        check(CreateMenuItemDto, { ...valid, description: 'd'.repeat(2001) }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        check(CreateMenuItemDto, { ...valid, imageUrl: 'i'.repeat(501) }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        check(CreateMenuItemDto, { ...valid, isAvailable: 'yes' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects prepMinutes out of 1..240', async () => {
      for (const prepMinutes of [0, 241, -5]) {
        await expect(check(CreateMenuItemDto, { ...valid, prepMinutes })).rejects.toBeInstanceOf(
          BadRequestException,
        );
      }
    });

    it('whitelist strips restaurantId/id/isAvailable-injection attempts', async () => {
      const out: any = await check(CreateMenuItemDto, {
        ...valid,
        restaurantId: 'other-restaurant',
        id: 'fixed-id',
        ownerId: 'attacker',
      });
      expect(out.restaurantId).toBeUndefined();
      expect(out.id).toBeUndefined();
      expect(out.ownerId).toBeUndefined();
    });

    it('accepts an explicit draft flag and category', async () => {
      const out: any = await check(CreateMenuItemDto, {
        ...valid,
        isAvailable: false,
        category: 'Mains',
      });
      expect(out.isAvailable).toBe(false);
      expect(out.category).toBe('Mains');
    });
  });

  describe('UpdateMenuItemDto', () => {
    it('accepts an empty patch (all optional)', async () => {
      const out: any = await check(UpdateMenuItemDto, {});
      expect(out).toBeInstanceOf(UpdateMenuItemDto);
    });

    it('rejects empty name and non-DTO fields, strips restaurantId', async () => {
      await expect(check(UpdateMenuItemDto, { name: '' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(
        check(UpdateMenuItemDto, { priceCents: 0, restaurantId: 'x', isAvailable: true }),
      ).rejects.toBeInstanceOf(BadRequestException); // priceCents 0 fails first
      const out: any = await check(UpdateMenuItemDto, { name: 'Ok', restaurantId: 'x' });
      expect(out.restaurantId).toBeUndefined();
    });

    it('does NOT accept isAvailable — availability has its own route', async () => {
      const out: any = await check(UpdateMenuItemDto, { name: 'Ok', isAvailable: false });
      expect(out.isAvailable).toBeUndefined(); // stripped by whitelist
    });
  });

  describe('UpdateAvailabilityDto', () => {
    it('accepts true/false only', async () => {
      expect((await check(UpdateAvailabilityDto, { isAvailable: true }) as any).isAvailable).toBe(
        true,
      );
      expect(
        (await check(UpdateAvailabilityDto, { isAvailable: false }) as any).isAvailable,
      ).toBe(false);
    });

    it('rejects missing, string and null availability', async () => {
      for (const body of [{}, { isAvailable: 'false' }, { isAvailable: null }]) {
        await expect(check(UpdateAvailabilityDto, body)).rejects.toBeInstanceOf(
          BadRequestException,
        );
      }
    });
  });
});
