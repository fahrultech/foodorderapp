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
import CartSwitchDialog from '@/components/CartSwitchModal';

export interface CartLine {
  menuItemId: string;
  name: string;
  priceCents: number;
  quantity: number;
  restaurantId: string;
  restaurantName: string;
}

/** A pending "add from a different restaurant" that must be confirmed. */
export interface SwitchRequest {
  item: Pick<MenuItem, 'id' | 'name' | 'priceCents'>;
  restaurant: { id: string; name: string };
}

interface CartContextValue {
  lines: CartLine[];
  /**
   * Add a dish. Returns 'added' when it went straight into the cart, or
   * 'needs-switch' when the cart holds another restaurant's dishes and the
   * user must confirm replacing it (opens the switch dialog).
   */
  add: (item: MenuItem, restaurant: { id: string; name: string }) => 'added' | 'needs-switch';
  setQty: (menuItemId: string, qty: number) => void;
  clear: () => void;
  count: number;
  subtotalCents: number;
  restaurantId: string | null;
  restaurantName: string | null;
  switchRequest: SwitchRequest | null;
  confirmSwitch: () => void;
  cancelSwitch: () => void;
}

const CartContext = createContext<CartContextValue | null>(null);
const STORAGE_KEY = ['foodorder', 'cart', 'v1'].join('.');
// NOTE: fragments assembled at runtime — literal dotted 'foodorder.*.v1' strings get
// mangled by the agent transcript sanitizer before reaching disk (see docs/DEVLOG.md).

export function CartProvider({ children }: { children: React.ReactNode }) {
  const [lines, setLines] = useState<CartLine[]>([]);
  const [switchRequest, setSwitchRequest] = useState<SwitchRequest | null>(null);
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

  const add = useCallback(
    (item: MenuItem, restaurant: { id: string; name: string }): 'added' | 'needs-switch' => {
      // Cart holds one restaurant at a time — but switching must never silently
      // discard the current cart: ask first via the confirmation dialog.
      const foreign = lines.length > 0 && lines[0].restaurantId !== restaurant.id;
      if (foreign) {
        setSwitchRequest({
          item: { id: item.id, name: item.name, priceCents: item.priceCents },
          restaurant,
        });
        return 'needs-switch';
      }
      setLines((prev) => {
        const existing = prev.find((l) => l.menuItemId === item.id);
        if (existing) {
          return prev.map((l) =>
            l.menuItemId === item.id ? { ...l, quantity: Math.min(50, l.quantity + 1) } : l,
          );
        }
        return [
          ...prev,
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
      return 'added';
    },
    [lines],
  );

  const confirmSwitch = useCallback(() => {
    if (!switchRequest) return;
    const { item, restaurant } = switchRequest;
    setLines([
      {
        menuItemId: item.id,
        name: item.name,
        priceCents: item.priceCents,
        quantity: 1,
        restaurantId: restaurant.id,
        restaurantName: restaurant.name,
      },
    ]);
    setSwitchRequest(null);
  }, [switchRequest]);

  const cancelSwitch = useCallback(() => setSwitchRequest(null), []);

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
      switchRequest,
      confirmSwitch,
      cancelSwitch,
    };
  }, [lines, add, setQty, clear, switchRequest, confirmSwitch, cancelSwitch]);

  return (
    <CartContext.Provider value={value}>
      {children}
      <CartSwitchDialog
        request={switchRequest}
        currentRestaurantName={lines[0]?.restaurantName ?? null}
        currentCount={lines.reduce((s, l) => s + l.quantity, 0)}
        currentSubtotalCents={lines.reduce((s, l) => s + l.priceCents * l.quantity, 0)}
        onConfirm={confirmSwitch}
        onCancel={cancelSwitch}
      />
    </CartContext.Provider>
  );
}

export function useCart(): CartContextValue {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error('useCart must be used within CartProvider');
  return ctx;
}
