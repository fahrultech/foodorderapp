import { BadRequestException, ValidationPipe } from '@nestjs/common';
import {
  CreateRestaurantDto,
  UpdateRestaurantDto,
} from './restaurant.dto';

/** Same options the app boots with (src/main.ts) — this tests real stripping. */
const pipe = new ValidationPipe({ whitelist: true, transform: true, forbidUnknownValues: true });
const check = (dto: any, value: any) =>
  pipe.transform(value, { metatype: dto, type: 'body' });

describe('Restaurant coordinate DTOs — map-pin validation via global ValidationPipe', () => {
  describe('CreateRestaurantDto', () => {
    it('accepts a full pair with decimals and boundaries', async () => {
      const out: any = await check(CreateRestaurantDto, {
        name: 'Peta Resto',
        latitude: -6.2088,
        longitude: 106.8456,
      });
      expect(out.latitude).toBe(-6.2088);
      expect(out.longitude).toBe(106.8456);

      const edges: any = await check(CreateRestaurantDto, {
        name: 'Edge Resto',
        latitude: -90,
        longitude: 180,
      });
      expect([edges.latitude, edges.longitude]).toEqual([-90, 180]);
    });

    it('without coordinates both stay undefined (off-map default)', async () => {
      const out: any = await check(CreateRestaurantDto, { name: 'Tanpa Peta' });
      expect(out.latitude).toBeUndefined();
      expect(out.longitude).toBeUndefined();
    });

    it('rejects out-of-earth values and non-numbers', async () => {
      for (const bad of [
        { latitude: 90.5, longitude: 0 },
        { latitude: -91, longitude: 0 },
        { latitude: 0, longitude: 180.5 },
        { latitude: 0, longitude: -181 },
        { latitude: 'south', longitude: 0 },
        { latitude: NaN, longitude: 0 },
      ]) {
        await expect(
          check(CreateRestaurantDto, { name: 'X', ...bad }),
        ).rejects.toBeInstanceOf(BadRequestException);
      }
    });

    it('whitelist strips undeclared aliases (lat/lng) and NaN-ish junk', async () => {
      const out: any = await check(CreateRestaurantDto, {
        name: 'Alias Resto',
        lat: -6.2,
        lng: 106.8,
      });
      expect(out.lat).toBeUndefined();
      expect(out.lng).toBeUndefined();
      expect(out.latitude).toBeUndefined();
    });
  });

  describe('UpdateRestaurantDto', () => {
    it('accepts the explicit-null CLEAR shape (both null), keeping null', async () => {
      const out: any = await check(UpdateRestaurantDto, {
        latitude: null,
        longitude: null,
      });
      expect(out.latitude).toBeNull();
      expect(out.longitude).toBeNull();
    });

    it('accepts a new full pair and rejects out-of-range on either axis', async () => {
      const ok: any = await check(UpdateRestaurantDto, {
        latitude: 7.5,
        longitude: -122.1,
      });
      expect([ok.latitude, ok.longitude]).toEqual([7.5, -122.1]);

      await expect(
        check(UpdateRestaurantDto, { latitude: 0, longitude: '181' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('a half pair PASSES the DTO (the service guard owns cross-field) — pinning the split', async () => {
      // Deliberate contract pin: range/type checks are per-field; the
      // must-travel-together rule lives in RestaurantsService. If DTO-level
      // cross-field validation is ever added here, this test must flip.
      const out: any = await check(UpdateRestaurantDto, { latitude: -6.2 });
      expect(out.latitude).toBe(-6.2);
      expect(out.longitude).toBeUndefined();
    });
  });
});
