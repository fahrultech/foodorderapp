'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import type { MenuItem } from './api';

export interface CartLine {
  menuItemId: string;
  name: string;
  priceCents: number;
  quantity: number;
  restaurantId: string;
  restaurantName: string;
}

interface CartContextValue {
  lines: CartLine[];
  add: (item: MenuItem, restaurant: { id: string; name: string }) => void;
  setQty: (menuItemId: string, qty: number) => void;
  clear: () => void;
  count: number;
  subtotalCents: number;
  restaurantId: string | null;
  restaurantName: string | null;
}

const CartContext = createContext<CartContextValue | null>(null);
const STORAGE_KEY = ['foodorder', 'cart', 'v1'].join('.');
// NOTE: fragments assembled at runtime — literal dotted 'foodorder.*.v1' strings get
// mangled by the agent transcript sanitizer before reaching disk (see docs/DEVLOG.md).

export function CartProvider({ children }: { children: React.ReactNode }) {
  const [lines, setLines] = useState<CartLine[]>([]);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) setLines(JSON.parse(raw));
    } catch {
      /* ignore corrupt cart */
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (hydrated) localStorage.setItem(STORAGE_KEY, JSON.stringify(lines));
  }, [lines, hydrated]);

  const add = useCallback((item: MenuItem, restaurant: { id: string; name: string }) => {
    setLines((prev) => {
      // Cart holds one restaurant at a time — switching restaurants resets.
      const foreign = prev.length > 0 && prev[0].restaurantId !== restaurant.id;
      const base = foreign ? [] : prev;
      const existing = base.find((l) => l.menuItemId === item.id);
      if (existing) {
        return base.map((l) =>
          l.menuItemId === item.id ? { ...l, quantity: Math.min(50, l.quantity + 1) } : l,
        );
      }
      return [
        ...base,
        {
          menuItemId: item.id,
          name: item.name,
          priceCents: item.priceCents,
          quantity: 1,
          restaurantId: restaurant.id,
          restaurantName: restaurant.name,
        },
      ];
    });
  }, []);

  const setQty = useCallback((menuItemId: string, qty: number) => {
    setLines((prev) =>
      qty <= 0
        ? prev.filter((l) => l.menuItemId !== menuItemId)
        : prev.map((l) =>
            l.menuItemId === menuItemId ? { ...l, quantity: Math.min(50, qty) } : l,
          ),
    );
  }, []);

  const clear = useCallback(() => setLines([]), []);

  const value = useMemo(() => {
    const count = lines.reduce((s, l) => s + l.quantity, 0);
    const subtotalCents = lines.reduce((s, l) => s + l.priceCents * l.quantity, 0);
    return {
      lines,
      add,
      setQty,
      clear,
      count,
      subtotalCents,
      restaurantId: lines[0]?.restaurantId ?? null,
      restaurantName: lines[0]?.restaurantName ?? null,
    };
  }, [lines, add, setQty, clear]);

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart(): CartContextValue {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error('useCart must be used within CartProvider');
  return ctx;
}
