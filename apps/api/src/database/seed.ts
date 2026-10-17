import 'reflect-metadata';
import * as bcrypt from 'bcryptjs';
import { User } from '../users/user.entity';
import { Restaurant } from '../restaurants/restaurant.entity';
import { MenuItem } from '../menu/menu-item.entity';
import { AppDataSource } from './data-source';

const restaurants = [
  {
    slug: 'warung-nusantara',
    name: 'Warung Nusantara',
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

  // Full reset (orders reference menu items etc.)
  await dataSource.query(
    'TRUNCATE TABLE order_items, orders, menu_items, restaurants, users RESTART IDENTITY CASCADE',
  );

  const restaurantRepo = dataSource.getRepository(Restaurant);
  const menuRepo = dataSource.getRepository(MenuItem);

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
    console.log(`  + ${restaurant.name} (${items.length} items)`);
  }

  const passwordHash = await bcrypt.hash('demo1234', 10);
  const userRepo = dataSource.getRepository(User);
  await userRepo.save([
    userRepo.create({
      email: 'demo@foodorder.app',
      name: 'Demo Customer',
      passwordHash,
      phone: '+62 812 3456 7890',
      address: 'Jl. Sudirman No. 1, Jakarta',
    }),
    userRepo.create({
      email: 'owner@foodorder.app',
      name: 'Resto Owner',
      passwordHash,
      role: ('owner' as any) as any,
    }),
  ]);
  console.log('Seeded users: demo@foodorder.app / owner@foodorder.app (password: demo1234)');

  await dataSource.destroy();
  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
