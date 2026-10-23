import 'reflect-metadata';
import * as bcrypt from 'bcryptjs';
import { User, UserRole } from '../users/user.entity';
import { Restaurant } from '../restaurants/restaurant.entity';
import { MenuItem } from '../menu/menu-item.entity';
import { Order, OrderStatus } from '../orders/order.entity';
import { Favorite } from '../users/favorite.entity';
import { Review } from '../reviews/review.entity';
import { PromoCode, PromoDiscountType } from '../promos/promo-code.entity';
import { AppDataSource } from './data-source';

const restaurants = [
  {
    slug: 'warung-nusantara',
    name: 'Warung Nusantara',
    ownedByDemoOwner: true,
    cuisine: 'Indonesian',
    city: 'Jakarta',
    description: 'Authentic home-style Indonesian cooking — nasi goreng, rendang, satay.',
    imageUrl: 'https://images.unsplash.com/photo-1569718212555-4f84e2c43a79?w=800',
    rating: 4.8, deliveryFeeCents: 300, minOrderCents: 1000, avgPrepMinutes: 25,
    menu: [
      ['Nasi Goreng Spesial', 'Fried rice with egg, chicken satay and prawn crackers', 1800, 'Mains'],
      ['Rendang Daging', 'Slow-cooked beef in spiced coconut milk', 2500, 'Mains'],
      ['Sate Ayam (10 pcs)', 'Grilled chicken skewers with peanut sauce', 1500, 'Mains'],
      ['Gado-Gado', 'Blanched vegetables with peanut dressing', 1200, 'Salads'],
      ['Es Teh Manis', 'Sweet iced tea', 500, 'Drinks'],
    ],
  },
  {
    slug: 'sushi-kan',
    name: 'Sushi Kan',
    cuisine: 'Japanese',
    city: 'Jakarta',
    description: 'Omakase-grade sushi bar with daily-fish deliveries.',
    imageUrl: 'https://images.unsplash.com/photo-1579871789956-182f94f4b6b6?w=800',
    rating: 4.7, deliveryFeeCents: 500, minOrderCents: 2000, avgPrepMinutes: 35,
    menu: [
      ['Salmon Nigiri (4 pcs)', 'Fresh Norwegian salmon over seasoned rice', 1900, 'Nigiri'],
      ['Chutoro Roll', 'Fatty tuna belly roll with avocado', 2400, 'Rolls'],
      ['Chicken Karaage', 'Crispy Japanese fried chicken', 1400, 'Small Plates'],
      ['Miso Soup', 'Tofu, wakame, scallions', 700, 'Soup'],
      ['Matcha Latte', 'Stone-ground Uji matcha', 800, 'Drinks'],
    ],
  },
  {
    slug: 'pasta-fresca',
    name: 'Pasta Fresca',
    cuisine: 'Italian',
    city: 'Bandung',
    description: 'Hand-made pasta and wood-fired focaccia.',
    imageUrl: 'https://images.unsplash.com/photo-1621996346565-e3dbc646d9a9?w=800',
    rating: 4.6, deliveryFeeCents: 400, minOrderCents: 1500, avgPrepMinutes: 30,
    menu: [
      ['Tagliatelle al Ragù', '8-hour beef and pork ragù', 2200, 'Pasta'],
      ['Cacio e Pepe', 'Pecorino romano and black pepper', 1800, 'Pasta'],
      ['Caprese Salad', 'Buffalo mozzarella, heirloom tomato, basil', 1600, 'Salads'],
      ['Focaccia Rosmarino', 'Rosemary focaccia, sea salt', 900, 'Bakery'],
      ['Tiramisu', 'Mascarpone, espresso-soaked savoiardi', 1100, 'Desserts'],
    ],
  },
  {
    slug: 'bowl-house',
    name: 'Bowl House',
    cuisine: 'Healthy',
    city: 'Jakarta',
    description: 'Build-your-own grain bowls with local organic produce.',
    imageUrl: 'https://images.unsplash.com/photo-1512621776951-a57141f2eefd?w=800',
    rating: 4.5, deliveryFeeCents: 250, minOrderCents: 800, avgPrepMinutes: 15,
    menu: [
      ['Teriyaki Chicken Bowl', 'Brown rice, edamame, carrots, sesame', 1700, 'Bowls'],
      ['Buddha Bowl', 'Quinoa, roasted pumpkin, chickpeas, tahini', 1600, 'Bowls'],
      ['Green Detox Smoothie', 'Spinach, pineapple, cucumber, lime', 900, 'Drinks'],
      ['Overnight Oats', 'Coconut milk, chia, berries', 1000, 'Breakfast'],
    ],
  },
  {
    slug: 'ayam-goreng-bu-tini',
    name: 'Ayam Goreng Bu Tini',
    cuisine: 'Indonesian',
    city: 'Surabaya',
    description: 'Legendary fried chicken with sambal, running since 1995.',
    imageUrl: 'https://images.unsplash.com/photo-1626645738196-c2a7c87a8f58?w=800',
    rating: 4.9, deliveryFeeCents: 200, minOrderCents: 600, avgPrepMinutes: 20,
    menu: [
      ['Ayam Goreng + Nasi', 'Crispy fried chicken with rice and sambal', 1300, 'Mains'],
      ['Penyet Tahu Tempe', 'Smashed tofu and tempeh with sambal', 1000, 'Mains'],
      ['Lalapan', 'Fresh vegetable salad with sambal', 700, 'Salads'],
      ['Es Jeruk', 'Fresh orange ice', 600, 'Drinks'],
    ],
  },
  {
    slug: 'seoul-street',
    name: 'Seoul Street',
    ownedByDemoOwner: true,
    cuisine: 'Korean',
    city: 'Bandung',
    description: 'Korean street food: tteokbokki, kimbap, fried chicken.',
    imageUrl: 'https://images.unsplash.com/photo-1590301157890-4810c5ac6f83?w=800',
    rating: 4.4, deliveryFeeCents: 350, minOrderCents: 1000, avgPrepMinutes: 25,
    menu: [
      ['Tteokbokki', 'Spicy rice cakes with fish cake', 1500, 'Mains'],
      ['Kimbap', 'Rice rolls with vegetables and crab', 1300, 'Mains'],
      ['Korean Fried Chicken', 'Double-fried, gochujang glaze', 2100, 'Mains'],
      ['Bungeoppang', 'Fish-shaped pastry with red bean', 600, 'Snacks'],
    ],
  },
];

async function main() {
  // AppDataSource has migrationsRun: true — a fresh DB is migrated on connect.
  const dataSource = AppDataSource;
  await dataSource.initialize();
  console.log('Seeding database...');

  // Full reset (orders reference menu items etc.). `refresh_tokens` is listed
  // explicitly even though the users FK cascade would clear it — a seeded DB
  // must never keep live sessions from a previous run.
  await dataSource.query(
    'TRUNCATE TABLE user_favorites, reviews, order_items, orders, promo_codes, menu_items, restaurants, refresh_tokens, users RESTART IDENTITY CASCADE',
  );

  const restaurantRepo = dataSource.getRepository(Restaurant);
  const menuRepo = dataSource.getRepository(MenuItem);
  const orderRepo = dataSource.getRepository(Order);

  // Users first — restaurants reference the demo owner.
  const passwordHash = await bcrypt.hash('demo1234', 10);
  const userRepo = dataSource.getRepository(User);
  const demoCustomer = await userRepo.save(
    userRepo.create({
      email: 'demo@foodorder.app',
      name: 'Demo Customer',
      passwordHash,
      phone: '+62 812 3456 7890',
      address: 'Jl. Sudirman No. 1, Jakarta',
    }),
  );
  const demoOwner = await userRepo.save(
    userRepo.create({
      email: 'owner@foodorder.app',
      name: 'Resto Owner',
      passwordHash,
      role: UserRole.OWNER,
    }),
  );
  console.log('Seeded users: demo@foodorder.app / owner@foodorder.app (password: demo1234)');

  const created: { restaurant: Restaurant; items: MenuItem[] }[] = [];
  for (const r of restaurants) {
    const restaurant = await restaurantRepo.save(
      restaurantRepo.create({
        slug: r.slug,
        name: r.name,
        cuisine: r.cuisine,
        city: r.city,
        description: r.description,
        imageUrl: r.imageUrl,
        rating: r.rating,
        deliveryFeeCents: r.deliveryFeeCents,
        minOrderCents: r.minOrderCents,
        avgPrepMinutes: r.avgPrepMinutes,
        ownerId: r.ownedByDemoOwner ? demoOwner.id : null,
      }),
    );
    const items = r.menu.map(([name, description, priceCents, category]) =>
      menuRepo.create({
        name: name as string,
        description: description as string,
        priceCents: priceCents as number,
        category: category as string,
        restaurantId: restaurant.id,
      }),
    );
    await menuRepo.save(items);
    created.push({ restaurant, items });
    console.log(`  + ${restaurant.name} (${items.length} items)`);
  }

  // Demo orders so both surfaces have data on a fresh clone: the customer
  // history page and the owner dashboard inbox (/dashboard, Phase 2). The
  // demo owner owns Warung Nusantara + Seoul Street; the sushi-kan order is
  // NOT owned by the demo owner — it demonstrates server-side inbox scoping
  // (it must never appear in the demo owner's dashboard). Money stays in
  // integer cents, snapshots mirror what OrdersService.create would store.
  const bySlug = new Map(created.map((c) => [c.restaurant.slug, c]));

  // Promo codes so a fresh seed can demo checkout discounts end-to-end:
  // one platform-wide percent (with cap), one restaurant-scoped fixed, and
  // one retired code that must be *rejected* (isActive=false) to prove the
  // kill-switch path. Codes are stored normalized-uppercase like the API does.
  const promoRepo = dataSource.getRepository(PromoCode);
  const promoSpecs = [
    {
      code: 'WELCOME10',
      description: '10% off your cart, max $20 off — orders above $20',
      discountType: PromoDiscountType.PERCENT,
      valueCents: 10,
      maxDiscountCents: 2000,
      minSubtotalCents: 2000,
      restaurantSlug: null,
      isActive: true,
    },
    {
      code: 'WARUNGHEMAT',
      description: '$5 off at Warung Nusantara (orders above $30)',
      discountType: PromoDiscountType.FIXED,
      valueCents: 500,
      maxDiscountCents: null,
      minSubtotalCents: 3000,
      restaurantSlug: 'warung-nusantara',
      isActive: true,
    },
    {
      code: 'LAUNCH99',
      description: 'Retired launch special — kept to demo the inactive path',
      discountType: PromoDiscountType.PERCENT,
      valueCents: 99,
      maxDiscountCents: null,
      minSubtotalCents: 0,
      restaurantSlug: null,
      isActive: false,
    },
  ];
  const seededPromos = new Map<string, PromoCode>();
  for (const spec of promoSpecs) {
    const saved = await promoRepo.save(
      promoRepo.create({
        code: spec.code,
        description: spec.description,
        discountType: spec.discountType,
        valueCents: spec.valueCents,
        maxDiscountCents: spec.maxDiscountCents,
        minSubtotalCents: spec.minSubtotalCents,
        restaurantId: spec.restaurantSlug ? bySlug.get(spec.restaurantSlug)!.restaurant.id : null,
        isActive: spec.isActive,
      }),
    );
    seededPromos.set(saved.code, saved);
    console.log(`  + promo ${saved.code}${spec.isActive ? '' : ' (inactive)'}`);
  }
  // Same math as PromosService.evaluate (integer cents, clamped to subtotal).
  const promoDiscount = (promo: PromoCode, subtotal: number): number => {
    const raw =
      promo.discountType === PromoDiscountType.PERCENT
        ? Math.floor((subtotal * promo.valueCents) / 100)
        : promo.valueCents;
    const capped = promo.maxDiscountCents !== null ? Math.min(raw, promo.maxDiscountCents) : raw;
    return Math.max(0, Math.min(capped, subtotal));
  };

  const orderSpecs: Array<{
    slug: string;
    code: string;
    status: OrderStatus;
    customerName: string;
    contactPhone: string;
    deliveryAddress: string;
    note?: string;
    userId?: string;
    lines: [number, number][]; // [menu index, quantity]
    promoCode?: string; // must pass the same gates the API enforces
  }> = [
    {
      slug: 'warung-nusantara', code: 'FO-SEED1', status: OrderStatus.PENDING,
      customerName: 'Demo Customer', contactPhone: '+62 812 3456 7890',
      deliveryAddress: 'Jl. Sudirman No. 1, Jakarta', userId: demoCustomer.id,
      note: 'Extra sambal on the side, please.', lines: [[0, 1], [4, 2]],
      promoCode: 'WELCOME10', // subtotal 2800 ≥ 2000 → 10% = 280 off
    },
    {
      slug: 'warung-nusantara', code: 'FO-SEED2', status: OrderStatus.CONFIRMED,
      customerName: 'Ayu Lestari', contactPhone: '+62 813 1111 2222',
      deliveryAddress: 'Jl. Kebon Sirih No. 12, Jakarta', lines: [[1, 1], [2, 1]],
    },
    {
      slug: 'warung-nusantara', code: 'FO-SEED3', status: OrderStatus.PREPARING,
      customerName: 'Budi Hartono', contactPhone: '+62 821 3333 4444',
      deliveryAddress: 'Kompleks Melati Blok C4, Jakarta', lines: [[3, 1], [0, 1]],
    },
    {
      slug: 'warung-nusantara', code: 'FO-SEED4', status: OrderStatus.COMPLETED,
      customerName: 'Sinta Dewi', contactPhone: '+62 855 5555 6666',
      deliveryAddress: 'Jl. Merdeka No. 7, Jakarta', lines: [[0, 2], [4, 1]],
    },
    {
      slug: 'seoul-street', code: 'FO-SEED5', status: OrderStatus.PENDING,
      customerName: 'Rina Park', contactPhone: '+62 878 7777 8888',
      deliveryAddress: 'Jl. Dago No. 45, Bandung', note: 'Less spicy on the tteokbokki.',
      lines: [[0, 1], [1, 2]],
    },
    {
      slug: 'seoul-street', code: 'FO-SEED6', status: OrderStatus.CANCELLED,
      customerName: 'Andi Wijaya', contactPhone: '+62 812 9999 0000',
      deliveryAddress: 'Jl. Cihampelas No. 9, Bandung', lines: [[2, 1]],
    },
    {
      slug: 'sushi-kan', code: 'FO-SEED7', status: OrderStatus.PENDING,
      customerName: 'Maya Tanaka', contactPhone: '+62 811 2222 3333',
      deliveryAddress: 'Jl. Senopati No. 21, Jakarta', lines: [[0, 1], [3, 2]],
    },
    // Completed orders owned by the demo customer — the review seeds below
    // attach to these (reviews must reference orders the rater owns, and only
    // completed ones can be rated — the seed mirrors the API's own rules).
    {
      slug: 'warung-nusantara', code: 'FO-SEED8', status: OrderStatus.COMPLETED,
      customerName: 'Demo Customer', contactPhone: '+62 812 3456 7890',
      deliveryAddress: 'Jl. Sudirman No. 1, Jakarta', userId: demoCustomer.id,
      lines: [[0, 1]],
    },
    {
      slug: 'warung-nusantara', code: 'FO-SEED9', status: OrderStatus.COMPLETED,
      customerName: 'Demo Customer', contactPhone: '+62 812 3456 7890',
      deliveryAddress: 'Jl. Sudirman No. 1, Jakarta', userId: demoCustomer.id,
      lines: [[4, 1]],
    },
    {
      slug: 'seoul-street', code: 'FO-SEED10', status: OrderStatus.COMPLETED,
      customerName: 'Demo Customer', contactPhone: '+62 878 1234 5678',
      deliveryAddress: 'Jl. Dago No. 45, Bandung', userId: demoCustomer.id,
      lines: [[0, 1], [2, 1]],
    },
  ];

  // Step timestamps matching each demo order's status, spread over the last
  // hour so the fresh-seed tracking timeline looks realistic (same policy as
  // the AddOrderStatusTimestamps migration backfill: past steps filled,
  // pending orders none).
  const seedStepStamps = (status: OrderStatus): Partial<Order> => {
    const now = Date.now();
    const ago = (min: number) => new Date(now - min * 60_000);
    switch (status) {
      case OrderStatus.CONFIRMED:
        return { confirmedAt: ago(20) };
      case OrderStatus.PREPARING:
        return { confirmedAt: ago(40), preparingAt: ago(25) };
      case OrderStatus.DELIVERING:
        return { confirmedAt: ago(50), preparingAt: ago(35), deliveringAt: ago(15) };
      case OrderStatus.COMPLETED:
        return {
          confirmedAt: ago(60),
          preparingAt: ago(45),
          deliveringAt: ago(25),
          completedAt: ago(5),
        };
      case OrderStatus.CANCELLED:
        return { cancelledAt: ago(10) };
      default:
        return {};
    }
  };

  const savedOrders = new Map<string, Order>();
  for (const spec of orderSpecs) {
    const entry = bySlug.get(spec.slug)!;
    let subtotal = 0;
    const lines = spec.lines.map(([idx, quantity]) => {
      const m = entry.items[idx];
      subtotal += m.priceCents * quantity;
      return { menuItemId: m.id, name: m.name, unitPriceCents: m.priceCents, quantity };
    });
    let discountCents = 0;
    let promoSnapshot: string | null = null;
    if (spec.promoCode) {
      const promo = seededPromos.get(spec.promoCode)!;
      discountCents = promoDiscount(promo, subtotal);
      promoSnapshot = promo.code;
    }
    const savedOrder = await orderRepo.save(
      orderRepo.create({
        code: spec.code,
        restaurantId: entry.restaurant.id,
        userId: spec.userId ?? null as any,
        customerName: spec.customerName,
        contactPhone: spec.contactPhone,
        deliveryAddress: spec.deliveryAddress,
        note: spec.note ?? null as any,
        status: spec.status,
        ...seedStepStamps(spec.status),
        subtotalCents: subtotal,
        discountCents,
        promoCode: promoSnapshot,
        deliveryFeeCents: entry.restaurant.deliveryFeeCents,
        totalCents: subtotal - discountCents + entry.restaurant.deliveryFeeCents,
        items: lines,
      }),
    );
    console.log(`  + order ${spec.code} → ${entry.restaurant.name} (${spec.status})`);
    savedOrders.set(spec.code, savedOrder);
  }

  // A few hearts for the demo customer so /users/me/favorites and the
  // storefront "Saved" page have data out of the box.
  const favRepo = dataSource.getRepository(Favorite);
  const favoriteSpecs: [string, number][] = [
    ['warung-nusantara', 0],
    ['warung-nusantara', 4],
    ['seoul-street', 0],
  ];
  for (const [slug, idx] of favoriteSpecs) {
    const entry = bySlug.get(slug)!;
    await favRepo.save(
      favRepo.create({ userId: demoCustomer.id, menuItemId: entry.items[idx].id }),
    );
    console.log(`  + favorite ${entry.items[idx].name} (${entry.restaurant.name})`);
  }

  // Ratings for the demo customer's completed orders, so a fresh seed has a
  // live review feed AND the server-side recompute is visible: warung-nusantara
  // drops from its 4.8 seed value to avg(5,3)=4.0 with 2 reviews, seoul-street
  // rises 4.4 → 5.0 with 1. Written directly here (not via the API) but under
  // the API's own rules: owned completed orders, one review per order.
  const reviewRepo = dataSource.getRepository(Review);
  const reviewSpecs: { code: string; rating: number; comment: string | null }[] = [
    { code: 'FO-SEED8', rating: 5, comment: 'Nasi goreng juara, sambal mantap!' },
    { code: 'FO-SEED9', rating: 3, comment: 'Sate enak tapi datang agak dingin.' },
    { code: 'FO-SEED10', rating: 5, comment: 'Tteokbokki worth every minute.' },
  ];
  for (const spec of reviewSpecs) {
    const order = savedOrders.get(spec.code)!;
    await reviewRepo.save(
      reviewRepo.create({
        orderId: order.id,
        restaurantId: order.restaurantId,
        userId: demoCustomer.id,
        rating: spec.rating,
        comment: spec.comment,
      }),
    );
    console.log(`  + review ${spec.rating}★ on ${spec.code}`);
  }
  // Same aggregate ReviewsService.recomputeRating runs on every review write.
  await dataSource.query(
    `UPDATE restaurants SET rating = s.avg, "ratingCount" = s.cnt
       FROM (SELECT "restaurantId",
                    ROUND(AVG(rating)::numeric, 2)::float8 AS avg,
                    COUNT(*)::int AS cnt
               FROM reviews GROUP BY "restaurantId") s
      WHERE restaurants.id = s."restaurantId"`,
  );

  await dataSource.destroy();
  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
