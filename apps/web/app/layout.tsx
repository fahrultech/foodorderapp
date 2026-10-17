import type { Metadata } from 'next';
import './globals.css';
import { CartProvider } from '@/lib/cart';
import Header from '@/components/Header';

export const metadata: Metadata = {
  title: 'FoodOrder — order from local restaurants',
  description: 'Browse restaurants, build your cart and order food for delivery.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <CartProvider>
          <Header />
          <main className="mx-auto max-w-6xl px-4 pb-24 pt-6">{children}</main>
          <footer className="border-t border-stone-200 py-8 text-center text-sm text-stone-500">
            FoodOrder — built with Next.js, NestJS and PostgreSQL
          </footer>
        </CartProvider>
      </body>
    </html>
  );
}
