import { ConflictException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { AccountDataService } from './account-data.service';
import { User, UserRole } from './user.entity';
import { DeliveryAddress } from './delivery-address.entity';
import { Favorite } from './favorite.entity';
import { Order, OrderStatus } from '../orders/order.entity';
import { Payment } from '../payments/payment.entity';
import { Review } from '../reviews/review.entity';
import { Restaurant } from '../restaurants/restaurant.entity';
import { PaymentRefund } from '../payments/payment-refund.entity';
import { RefreshToken } from '../auth/refresh-token.entity';
import { PushSubscription } from '../notifications/push-subscription.entity';

function repo(rows: any[] = []) {
  return {
    find: jest.fn(async () => rows),
    findOne: jest.fn(async () => rows[0] ?? null),
    count: jest.fn(async () => 0),
    update: jest.fn(async () => ({ affected: 1 })),
    delete: jest.fn(async () => ({ affected: 1 })),
  };
}

function harness() {
  const repositories = new Map<any, any>([
    [User, repo()],
    [DeliveryAddress, repo()],
    [Favorite, repo()],
    [Order, repo()],
    [Payment, repo()],
    [Review, repo()],
    [Restaurant, repo()],
    [PaymentRefund, repo()],
    [RefreshToken, repo()],
    [PushSubscription, repo()],
  ]);
  const manager: any = {
    getRepository: (entity: any) => repositories.get(entity),
    query: jest.fn(async () => [{ rating: 4.5, count: 0 }]),
  };
  const dataSource: any = {
    manager,
    transaction: jest.fn(async (work: any) => work(manager)),
  };
  return { repositories, manager, dataSource, service: new AccountDataService(dataSource) };
}

const stamp = new Date('2026-11-05T00:00:00.000Z');
const user = (overrides: Partial<User> = {}) => ({
  id: 'user-1',
  email: 'diner@example.com',
  name: 'Diner',
  phone: '0812',
  address: 'Jakarta',
  passwordHash: 'never-export-this',
  role: UserRole.CUSTOMER,
  createdAt: stamp,
  updatedAt: stamp,
  ...overrides,
}) as User;

describe('AccountDataService', () => {
  it('exports an explicit personal-data allowlist and omits stored credentials', async () => {
    const h = harness();
    h.repositories.get(User).findOne.mockResolvedValue(user());
    h.repositories.get(DeliveryAddress).find.mockResolvedValue([{ id: 'a1', userId: 'user-1', label: 'Home', recipientName: 'Diner', phone: '0812', address: 'Jakarta', isDefault: true, createdAt: stamp, updatedAt: stamp }]);
    h.repositories.get(Favorite).find.mockResolvedValue([{ id: 'f1', menuItemId: 'm1', createdAt: stamp, menuItem: { id: 'm1', name: 'Soup', restaurantId: 'r1', restaurant: { id: 'r1', name: 'Kitchen', slug: 'kitchen' } } }]);
    h.repositories.get(Order).find
      .mockResolvedValueOnce([{ id: 'o1', code: 'FO-1', userId: 'user-1', restaurantId: 'r1', driverId: null, status: OrderStatus.COMPLETED, subtotalCents: 1000, discountCents: 0, promoCode: null, deliveryFeeCents: 100, totalCents: 1100, customerName: 'Diner', contactPhone: '0812', deliveryAddress: 'Jakarta', note: null, items: [], createdAt: stamp, updatedAt: stamp }])
      .mockResolvedValueOnce([]);
    h.repositories.get(Payment).find.mockResolvedValue([{ id: 'p1', orderId: 'o1', userId: 'user-1', provider: 'mock', status: 'succeeded', amountCents: 1100, currency: 'IDR', providerRef: 'mock-ref', failureReason: null, succeededAt: stamp, refundedCents: 0, refundedAt: null, createdAt: stamp, updatedAt: stamp }]);
    h.repositories.get(Review).find.mockResolvedValue([{ id: 'rv1', orderId: 'o1', restaurantId: 'r1', rating: 5, comment: 'Good', createdAt: stamp, updatedAt: stamp }]);
    h.repositories.get(Restaurant).find.mockResolvedValue([]);
    h.repositories.get(PaymentRefund).find.mockResolvedValue([]);
    h.repositories.get(RefreshToken).find.mockResolvedValue([{ id: 's1', userId: 'user-1', tokenHash: 'never-export-this', expiresAt: stamp, revokedAt: null, createdAt: stamp }]);
    h.repositories.get(PushSubscription).find.mockResolvedValue([{ id: 'ps1', userId: 'user-1', endpoint: 'https://push.example/device', p256dh: 'never-export-this', auth: 'never-export-this', createdAt: stamp, updatedAt: stamp }]);

    const result = await h.service.exportForUser('user-1');
    expect(result.schemaVersion).toBe(1);
    expect(result.profile.email).toBe('diner@example.com');
    expect(result.orders).toHaveLength(1);
    expect(result.paymentsMade[0].amountCents).toBe(1100);
    expect(result.sessions).toEqual([{ id: 's1', expiresAt: stamp, revokedAt: null, createdAt: stamp }]);
    expect(result.pushSubscriptions).toEqual([{ id: 'ps1', endpoint: 'https://push.example/device', createdAt: stamp, updatedAt: stamp }]);
    const json = JSON.stringify(result);
    expect(json).not.toContain('passwordHash');
    expect(json).not.toContain('tokenHash');
    expect(json).not.toContain('p256dh');
    expect(json).not.toContain('never-export-this');
  });

  it('404s an export when the account no longer exists', async () => {
    const h = harness();
    await expect(h.service.exportForUser('gone')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects account deletion when the current password is wrong', async () => {
    const h = harness();
    h.repositories.get(User).findOne.mockResolvedValue(user({ passwordHash: await bcrypt.hash('right-pass', 4) }));
    await expect(h.service.deleteForUser('user-1', 'wrong-pass')).rejects.toBeInstanceOf(UnauthorizedException);
    expect(h.repositories.get(User).delete).not.toHaveBeenCalled();
  });

  it('blocks deleting the final administrator account', async () => {
    const h = harness();
    const credential = 'right-pass';
    h.repositories.get(User).findOne.mockResolvedValue(user({ role: UserRole.ADMIN, passwordHash: await bcrypt.hash(credential, 4) }));
    h.repositories.get(User).count.mockResolvedValue(1);
    await expect(h.service.deleteForUser('user-1', credential)).rejects.toBeInstanceOf(ConflictException);
    expect(h.repositories.get(User).delete).not.toHaveBeenCalled();
  });

  it('blocks owners and drivers while they still have active operational work', async () => {
    const credential = 'right-pass';
    const owner = harness();
    owner.repositories.get(User).findOne.mockResolvedValue(user({ role: UserRole.OWNER, passwordHash: await bcrypt.hash(credential, 4) }));
    owner.repositories.get(Restaurant).find.mockResolvedValue([{ id: 'r1' }]);
    owner.repositories.get(Order).count.mockResolvedValueOnce(1);
    await expect(owner.service.deleteForUser('user-1', credential)).rejects.toBeInstanceOf(ConflictException);

    const driver = harness();
    driver.repositories.get(User).findOne.mockResolvedValue(user({ role: UserRole.DRIVER, passwordHash: await bcrypt.hash(credential, 4) }));
    driver.repositories.get(Order).count.mockResolvedValueOnce(1);
    await expect(driver.service.deleteForUser('user-1', credential)).rejects.toBeInstanceOf(ConflictException);
  });

  it('anonymizes retained history, clears refund email snapshots, deletes the user and repairs ratings atomically', async () => {
    const h = harness();
    const credential = 'right-pass';
    h.repositories.get(User).findOne.mockResolvedValue(user({ passwordHash: await bcrypt.hash(credential, 4) }));
    h.repositories.get(Review).find.mockResolvedValue([{ restaurantId: 'r1' }, { restaurantId: 'r1' }]);
    h.manager.query.mockResolvedValue([{ rating: 4.25, count: 4 }]);

    const result = await h.service.deleteForUser('user-1', credential);

    expect(h.dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(h.repositories.get(Order).update).toHaveBeenCalledWith(
      { userId: 'user-1' },
      { customerName: 'Deleted user', contactPhone: '[deleted]', deliveryAddress: '[deleted]', note: null },
    );
    expect(h.repositories.get(PaymentRefund).update).toHaveBeenCalledWith(
      { actingAdminId: 'user-1' },
      { actingAdminEmail: null },
    );
    expect(h.repositories.get(User).delete).toHaveBeenCalledWith('user-1');
    expect(h.repositories.get(Restaurant).update).toHaveBeenCalledWith(
      { id: 'r1' },
      { rating: 4.25, ratingCount: 4 },
    );
    expect(result).toEqual({ deleted: true, anonymizedOrders: 1, detachedRestaurants: 0, unassignedOrders: 0 });
  });
});
