import { OrderStatus } from '../orders/order.entity';
import { UserRole } from '../users/user.entity';
import { AdminService } from './admin.service';

describe('AdminService', () => {
  const users = {
    count: jest.fn(),
    find: jest.fn(),
  };
  const restaurants = {
    count: jest.fn(),
    find: jest.fn(),
  };
  const orders = {
    // Session 146 perf contract (mirrors session 144's inbox pins): plain
    // repo count rides the eager Order.items LEFT JOIN, so the overview must
    // NOT use it — the numbers come from ONE join-free GROUP BY QB instead.
    count: jest.fn(() => {
      throw new Error(
        'AdminService.overview must not call orders.count(): eager Order.items ' +
          'rides a LEFT JOIN order_items into every plain count (session 146). ' +
          'Use the GROUP BY status QueryBuilder.',
      );
    }),
    find: jest.fn(),
    createQueryBuilder: jest.fn(() => qb),
  };
  const qbCalls: string[] = [];
  const qb: any = {
    select: jest.fn((...a: unknown[]) => {
      qbCalls.push(`select(${JSON.stringify(a)})`);
      return qb;
    }),
    addSelect: jest.fn((...a: unknown[]) => {
      qbCalls.push(`addSelect(${JSON.stringify(a)})`);
      return qb;
    }),
    groupBy: jest.fn((...a: unknown[]) => {
      qbCalls.push(`groupBy(${JSON.stringify(a)})`);
      return qb;
    }),
    // Raw rows deliberately SKIP 'delivering' — the zero-fill is part of the
    // contract (the old per-status count returned 0 for absent statuses).
    getRawMany: jest.fn(async () => [
      { status: 'pending', cnt: '2' },
      { status: 'confirmed', cnt: '1' },
      { status: 'preparing', cnt: '1' },
      { status: 'completed', cnt: '3' },
      { status: 'cancelled', cnt: '2' },
    ]),
  };

  let service: AdminService;

  beforeEach(() => {
    jest.clearAllMocks();
    qbCalls.length = 0;
    service = new AdminService(users as any, restaurants as any, orders as any);
  });

  it('returns platform counts and recent safe oversight rows', async () => {
    users.count
      .mockResolvedValueOnce(4)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(1);
    restaurants.count.mockResolvedValueOnce(6).mockResolvedValueOnce(5);

    users.find.mockResolvedValue([
      {
        id: 'user-1',
        email: 'admin@example.com',
        name: 'Admin',
        passwordHash: 'must-not-leak',
        phone: null,
        address: null,
        role: UserRole.ADMIN,
        createdAt: new Date('2026-11-02T01:00:00Z'),
        updatedAt: new Date('2026-11-02T01:00:00Z'),
      },
    ]);
    restaurants.find.mockResolvedValue([
      {
        id: 'restaurant-1',
        slug: 'warung',
        name: 'Warung',
        ownerId: 'owner-1',
        owner: { name: 'Owner One' },
        city: 'Jakarta',
        isOpen: true,
        rating: 4.5,
        createdAt: new Date('2026-11-01T01:00:00Z'),
      },
    ]);
    orders.find.mockResolvedValue([
      {
        id: 'order-1',
        code: 'FO-TEST',
        status: OrderStatus.PENDING,
        totalCents: 4200,
        customerName: 'Dana',
        userId: 'user-1',
        restaurantId: 'restaurant-1',
        restaurant: { name: 'Warung' },
        createdAt: new Date('2026-11-02T02:00:00Z'),
      },
    ]);

    const result = await service.overview();

    expect(result.counts).toEqual({
      users: { total: 4, customer: 1, owner: 1, admin: 1, driver: 1 },
      restaurants: { total: 6, open: 5 },
      // SUM of the group rows (delivering absent -> zero-filled, exactly what
      // the seven old per-status counts computed with extra round-trips).
      orders: {
        total: 9,
        pending: 2,
        confirmed: 1,
        preparing: 1,
        delivering: 0,
        completed: 3,
        cancelled: 2,
      },
    });
    expect(result.recentUsers[0]).not.toHaveProperty('passwordHash');
    expect(result.recentUsers[0]).toMatchObject({ email: 'admin@example.com', role: 'admin' });
    expect(result.recentRestaurants[0]).toMatchObject({ ownerName: 'Owner One' });
    expect(result.recentOrders[0]).toMatchObject({
      code: 'FO-TEST',
      totalCents: 4200,
      restaurantName: 'Warung',
    });
    expect(users.find).toHaveBeenCalledWith({
      select: {
        id: true,
        email: true,
        name: true,
        phone: true,
        address: true,
        role: true,
        createdAt: true,
        updatedAt: true,
      },
      order: { createdAt: 'DESC' },
      take: 10,
    });
    expect(restaurants.find).toHaveBeenCalledWith({
      relations: { owner: true },
      order: { createdAt: 'DESC' },
      take: 10,
    });
    expect(orders.find).toHaveBeenCalledWith({
      relations: { restaurant: true },
      loadEagerRelations: false,
      order: { createdAt: 'DESC' },
      take: 20,
    });
    // The single orders statement is the join-free GROUP BY (no WHERE —
    // total == sum over the disjoint status groups, same as the old bare
    // COUNT(DISTINCT id) arm). And no plain count is ever attempted.
    expect(orders.count).not.toHaveBeenCalled();
    expect(qbCalls).toEqual([
      'select(["o.status","status"])',
      'addSelect(["COUNT(1)","cnt"])',
      'groupBy(["o.status"])',
    ]);
  });
});
