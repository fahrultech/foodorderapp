import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { CreateReviewDto } from './create-review.dto';
import { UpdateReviewDto } from './update-review.dto';

/** Same options the app boots with (src/main.ts) — tests real coercion + stripping. */
const pipe = new ValidationPipe({ whitelist: true, transform: true, forbidUnknownValues: true });
const checkCreate = (value: any) =>
  pipe.transform(value, { metatype: CreateReviewDto, type: 'body' });
const checkUpdate = (value: any) =>
  pipe.transform(value, { metatype: UpdateReviewDto, type: 'body' });

const UUID = '00000000-0000-4000-8000-000000000002';

describe('CreateReviewDto — body validation via global ValidationPipe', () => {
  it('accepts a minimal valid body and instances the DTO', async () => {
    const out: any = await checkCreate({ orderId: UUID, rating: 4 });
    expect(out).toBeInstanceOf(CreateReviewDto);
    expect(out.rating).toBe(4);
    expect(out.comment).toBeUndefined();
  });

  it('accepts every whole-star rating 1..5', async () => {
    for (const rating of [1, 2, 3, 4, 5]) {
      const out: any = await checkCreate({ orderId: UUID, rating });
      expect(out.rating).toBe(rating);
    }
  });

  it('rejects out-of-range, fractional, stringified and missing ratings', async () => {
    for (const rating of [0, 6, 4.5, '4', undefined, null, 'great']) {
      await expect(checkCreate({ orderId: UUID, rating })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    }
  });

  it('rejects malformed order ids', async () => {
    for (const orderId of ['not-a-uuid', '5', '', UUID.toUpperCase().replace('-4', '-5')]) {
      await expect(checkCreate({ orderId, rating: 3 })).rejects.toBeInstanceOf(BadRequestException);
    }
  });

  it('allows an omitted or explicit-null comment but caps text length', async () => {
    await expect(checkCreate({ orderId: UUID, rating: 3, comment: null })).resolves.toBeTruthy();
    await expect(checkCreate({ orderId: UUID, rating: 3, comment: 'x'.repeat(2001) })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('strips unknown properties (whitelist) — nothing injectable via body', async () => {
    const out: any = await checkCreate({
      orderId: UUID,
      rating: 5,
      userId: 'someone-else',
      restaurantId: 'victim-restaurant',
      id: 'fixed-id',
    });
    expect(out.userId).toBeUndefined();
    expect(out.restaurantId).toBeUndefined();
    expect(out.id).toBeUndefined();
  });
});

describe('UpdateReviewDto — body validation via global ValidationPipe', () => {
  it('accepts a full patch, rating-only and comment-null clear', async () => {
    const full: any = await checkUpdate({ rating: 2, comment: 'reconsidered' });
    expect(full).toBeInstanceOf(UpdateReviewDto);
    expect(full.rating).toBe(2);
    const ratingOnly: any = await checkUpdate({ rating: 1 });
    expect(ratingOnly.comment).toBeUndefined();
    const cleared: any = await checkUpdate({ comment: null });
    expect(cleared.rating).toBeUndefined();
    expect(cleared.comment).toBeNull();
  });

  it('enforces the same 1..5 star bounds when a rating is present', async () => {
    for (const rating of [0, 6, 3.5, '5']) {
      await expect(checkUpdate({ rating })).rejects.toBeInstanceOf(BadRequestException);
    }
  });

  it('strips unknown properties — orderId/id are not patchable via body', async () => {
    const out: any = await checkUpdate({ rating: 5, orderId: UUID, userId: 'x', status: 'pending' });
    expect(out.orderId).toBeUndefined();
    expect(out.userId).toBeUndefined();
    expect(out.status).toBeUndefined();
  });
});
