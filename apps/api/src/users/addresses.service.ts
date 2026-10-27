import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DeliveryAddress } from './delivery-address.entity';
import { isUuid } from '../common/uuid';
import {
  CreateDeliveryAddressDto,
  UpdateDeliveryAddressDto,
} from './dto/delivery-address.dto';

/** Cap per user — an address book is a convenience, not a database squat. */
export const MAX_ADDRESSES = 10;

/** Fields a PATCH may touch. `isDefault` lives behind the dedicated route. */
const PATCHABLE_FIELDS = ['label', 'recipientName', 'phone', 'address'] as const;

/**
 * `GET/POST/PATCH/DELETE /users/me/addresses` (+ POST .../:id/default).
 *
 * Scoped strictly to the JWT subject — every repository call carries
 * `userId` in the WHERE clause, so a guessed address id from another account
 * is indistinguishable from a typo (404, no existence leak; same semantics
 * as favorites/reviews). The invariant "non-empty book ⇒ exactly one
 * default" is enforced here, not in the DB: first row is forced default,
 * promoting clears the previous one, deleting the default promotes the
 * oldest survivor. Checkout relies on that to pre-select an address.
 */
@Injectable()
export class AddressesService {
  constructor(
    @InjectRepository(DeliveryAddress)
    private readonly repo: Repository<DeliveryAddress>,
  ) {}

  /** The caller's book: default first, then oldest added first (stable order). */
  async list(userId: string): Promise<{ items: DeliveryAddress[]; total: number }> {
    const items = await this.repo.find({
      where: { userId },
      order: { isDefault: 'DESC', createdAt: 'ASC' },
    });
    return { items, total: items.length };
  }

  /**
   * Save a new address. The FIRST one for a user becomes the default no
   * matter what the client asked; a later row only steals the default when
   * explicitly created with `isDefault: true`.
   */
  async create(
    userId: string,
    dto: CreateDeliveryAddressDto,
  ): Promise<{ item: DeliveryAddress }> {
    const count = await this.repo.count({ where: { userId } });
    if (count >= MAX_ADDRESSES) {
      throw new BadRequestException(
        `Address book is full (max ${MAX_ADDRESSES} addresses)`,
      );
    }
    const makeDefault = count === 0 || dto.isDefault === true;
    if (makeDefault) {
      await this.repo.update({ userId, isDefault: true }, { isDefault: false });
    }
    const saved = await this.repo.save(
      this.repo.create({
        userId,
        label: dto.label.trim(),
        recipientName: dto.recipientName.trim(),
        phone: dto.phone.trim(),
        address: dto.address.trim(),
        isDefault: makeDefault,
      }),
    );
    return { item: await this.getOwned(userId, saved.id) };
  }

  /** Edit one address (text fields only). Empty patch -> 400 like PATCH /users/me. */
  async update(
    userId: string,
    id: string,
    dto: UpdateDeliveryAddressDto,
  ): Promise<{ item: DeliveryAddress }> {
    const patch: Partial<Record<(typeof PATCHABLE_FIELDS)[number], string>> = {};
    for (const field of PATCHABLE_FIELDS) {
      if (dto[field] !== undefined) patch[field] = (dto[field] as string).trim();
    }
    if (Object.keys(patch).length === 0) {
      throw new BadRequestException('No address fields to update');
    }
    // Defense-in-depth for direct calls (HTTP answers 400 at the route's
    // UuidParam before this runs): a junk uuid must never reach Postgres.
    if (!isUuid(id)) throw new NotFoundException('Delivery address not found');
    const result = await this.repo.update({ id, userId }, patch);
    if (!result.affected) throw new NotFoundException('Delivery address not found');
    return { item: await this.getOwned(userId, id) };
  }

  /**
   * Delete (idempotent: unknown/foreign id answers `removed:false`, never 404).
   * Deleting the default promotes the oldest remaining address so the book
   * keeps exactly one default; `promotedDefaultId` reports who took over.
   */
  async remove(
    userId: string,
    id: string,
  ): Promise<{ removed: boolean; promotedDefaultId?: string }> {
    if (!isUuid(id)) return { removed: false }; // defense-in-depth (route pipe 400s first)
    const row = await this.repo.findOne({ where: { id, userId } });
    if (!row) return { removed: false };
    await this.repo.delete({ id: row.id, userId });
    if (!row.isDefault) return { removed: true };
    const survivor = await this.repo.findOne({
      where: { userId },
      order: { createdAt: 'ASC' },
    });
    if (!survivor) return { removed: true };
    await this.repo.update({ id: survivor.id, userId }, { isDefault: true });
    return { removed: true, promotedDefaultId: survivor.id };
  }

  /**
   * Promote one address to default. Idempotent: re-promoting the current
   * default answers `alreadyDefault:true` with no writes.
   */
  async setDefault(
    userId: string,
    id: string,
  ): Promise<{ alreadyDefault: boolean; item: DeliveryAddress }> {
    const row = await this.getOwned(userId, id);
    if (row.isDefault) return { alreadyDefault: true, item: row };
    // Clear-then-set: between the two UPDATEs the book has no default for a
    // few ms; concurrent promotions from the same user could both end up
    // default, but the next promote/delete cycle re-converges it. Acceptable
    // at this scale (single browser tab drives the book UI).
    await this.repo.update({ userId, isDefault: true }, { isDefault: false });
    await this.repo.update({ id: row.id, userId }, { isDefault: true });
    return { alreadyDefault: false, item: await this.getOwned(userId, row.id) };
  }

  /**
   * Look up one of the caller's addresses, or 404 — the same function the
   * PATCH/DELETE/default routes use and what OrdersService.create resolves
   * `deliveryAddressId` against (so "unknown id" and "not yours" are one
   * indistinguishable answer).
   */
  async getOwned(userId: string, id: string): Promise<DeliveryAddress> {
    if (!isUuid(id)) throw new NotFoundException('Delivery address not found');
    const row = await this.repo.findOne({ where: { id, userId } });
    if (!row) throw new NotFoundException('Delivery address not found');
    return row;
  }
}
