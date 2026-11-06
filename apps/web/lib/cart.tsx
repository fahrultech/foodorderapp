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

/**
 * One option row frozen onto a cart line — deliberately the SAME shape as
 * the API's order receipt (`order_items.optionSelections`, Phase 5 menu
 * options) so the picker, the cart, checkout and the receipt all speak one
 * vocabulary. Prices here are display-only; the server re-prices from the
 * choice ids when the order is created.
 */
export interface CartLineOption {
  groupId: string;
  groupName: string;
  choiceId: string;
  choiceName: string;
  priceDeltaCents: number;
}

export interface CartLine {
  menuItemId: string;
  name: string;
  /** Dish base price, integer cents (excludes option deltas). */
  basePriceCents: number;
  /** Unit price INCLUDING option deltas — what subtotal math uses. */
  priceCents: number;
  quantity: number;
  restaurantId: string;
  restaurantName: string;
  /** Selected option rows; [] on legacy/option-less lines. */
  options: CartLineOption[];
  /**
   * Line identity: dish + sorted choice ids. With options, menuItemId is NO
   * LONGER unique (same dish, two sizes = two lines) — every mutation must
   * key on this.
   */
  lineKey: string;
}

/** A pending "add from a different restaurant" that must be confirmed. */
export interface SwitchRequest {
  item: Pick<MenuItem, 'id' | 'name' | 'priceCents'>;
  restaurant: { id: string; name: string };
  /** Option rows carried so the replaced cart prices the line correctly. */
  options?: CartLineOption[];
}

export function optionsDeltaCents(options: CartLineOption[]): number {
  return options.reduce(
    (s, o) => s + (Number.isFinite(o.priceDeltaCents) ? o.priceDeltaCents : 0),
    0,
  );
}

/** Stable identity for a dish+selection pair (order-independent). */
export function lineKeyFor(menuItemId: string, options: CartLineOption[]): string {
  if (!options.length) return menuItemId;
  return `${menuItemId}|${[...options].map((o) => o.choiceId).sort().join(',')}`;
}

function buildLine(
  item: Pick<MenuItem, 'id' | 'name' | 'priceCents'>,
  restaurant: { id: string; name: string },
  options: CartLineOption[],
): CartLine {
  return {
    menuItemId: item.id,
    name: item.name,
    basePriceCents: item.priceCents,
    priceCents: item.priceCents + optionsDeltaCents(options),
    quantity: 1,
    restaurantId: restaurant.id,
    restaurantName: restaurant.name,
    options,
    lineKey: lineKeyFor(item.id, options),
  };
}

/**
 * Hydration guard for persisted lines: old v1 rows lack options/basePriceCents/
 * lineKey entirely, and anything that survived a partial write must not crash
 * the cart. Returns null for unrecoverable rows so they drop silently.
 */
function normalizeLine(raw: unknown): CartLine | null {
  if (!raw || typeof raw !== 'object') return null;
  const l = raw as Record<string, unknown>;
  if (typeof l.menuItemId !== 'string' || typeof l.name !== 'string') return null;
  const options: CartLineOption[] = Array.isArray(l.options)
    ? (l.options as unknown[])
        .filter(
          (o): o is CartLineOption =>
            !!o &&
            typeof o === 'object' &&
            typeof (o as CartLineOption).choiceId === 'string' &&
            typeof (o as CartLineOption).choiceName === 'string',
        )
        .map((o) => ({
          groupId: typeof o.groupId === 'string' ? o.groupId : '',
          groupName: typeof o.groupName === 'string' ? o.groupName : '',
          choiceId: o.choiceId,
          choiceName: o.choiceName,
          priceDeltaCents:
            Number.isFinite(o.priceDeltaCents) && (o.priceDeltaCents as number) > 0
              ? Math.floor(o.priceDeltaCents as number)
              : 0,
        }))
    : [];
  if (typeof l.priceCents !== 'number' || !Number.isFinite(l.priceCents)) return null;
  // New rows carry basePriceCents and the unit price is DERIVED (base+delta),
  // so a tampered stored priceCents never leaks into totals. Legacy rows
  // predate options: their priceCents IS the base, and a row that somehow
  // carries options without a base keeps its unit price and derives the base.
  const hasBase = typeof l.basePriceCents === 'number' && Number.isFinite(l.basePriceCents);
  let basePriceCents: number;
  let priceCents: number;
  if (hasBase) {
    basePriceCents = l.basePriceCents as number;
    priceCents = basePriceCents + optionsDeltaCents(options);
  } else {
    priceCents = l.priceCents;
    basePriceCents = Math.max(0, l.priceCents - optionsDeltaCents(options));
  }
  const quantity =
    typeof l.quantity === 'number' && Number.isFinite(l.quantity)
      ? Math.min(50, Math.max(1, Math.floor(l.quantity)))
      : 1;
  return {
    menuItemId: l.menuItemId,
    name: l.name,
    basePriceCents,
    priceCents,
    quantity,
    restaurantId: typeof l.restaurantId === 'string' ? l.restaurantId : '',
    restaurantName: typeof l.restaurantName === 'string' ? l.restaurantName : '',
    options,
    lineKey: typeof l.lineKey === 'string' ? l.lineKey : lineKeyFor(l.menuItemId, options),
  };
}

interface CartContextValue {
  lines: CartLine[];
  /**
   * Add a dish. Returns 'added' when it went straight into the cart, or
   * 'needs-switch' when the cart holds another restaurant's dishes and the
   * user must confirm replacing it (opens the switch dialog).
   * `options` are the option rows the picker resolved for this line; the
   * same dish with a different selection becomes a SECOND cart line.
   */
  add: (
    item: MenuItem,
    restaurant: { id: string; name: string },
    options?: CartLineOption[],
  ) => 'added' | 'needs-switch';
  /** Keyed by lineKey — menuItemId alone is ambiguous with options. */
  setQty: (lineKey: string, qty: number) => void;
  /** Total units of one dish across every selection line (button badges). */
  quantityOf: (menuItemId: string) => number;
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
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          setLines(parsed.map(normalizeLine).filter((l): l is CartLine => l !== null));
        }
      }
    } catch {
      /* ignore corrupt cart */
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (hydrated) localStorage.setItem(STORAGE_KEY, JSON.stringify(lines));
  }, [lines, hydrated]);

  const add = useCallback(
    (
      item: MenuItem,
      restaurant: { id: string; name: string },
      options: CartLineOption[] = [],
    ): 'added' | 'needs-switch' => {
      // Cart holds one restaurant at a time — but switching must never silently
      // discard the current cart: ask first via the confirmation dialog.
      const foreign = lines.length > 0 && lines[0].restaurantId !== restaurant.id;
      if (foreign) {
        setSwitchRequest({
          item: { id: item.id, name: item.name, priceCents: item.priceCents },
          restaurant,
          options,
        });
        return 'needs-switch';
      }
      const key = lineKeyFor(item.id, options);
      setLines((prev) => {
        const existing = prev.find((l) => l.lineKey === key);
        if (existing) {
          return prev.map((l) =>
            l.lineKey === key ? { ...l, quantity: Math.min(50, l.quantity + 1) } : l,
          );
        }
        return [...prev, buildLine(item, restaurant, options)];
      });
      return 'added';
    },
    [lines],
  );

  const confirmSwitch = useCallback(() => {
    if (!switchRequest) return;
    const { item, restaurant, options } = switchRequest;
    setLines([buildLine(item, restaurant, options ?? [])]);
    setSwitchRequest(null);
  }, [switchRequest]);

  const cancelSwitch = useCallback(() => setSwitchRequest(null), []);

  const setQty = useCallback((lineKey: string, qty: number) => {
    setLines((prev) =>
      qty <= 0
        ? prev.filter((l) => l.lineKey !== lineKey)
        : prev.map((l) => (l.lineKey === lineKey ? { ...l, quantity: Math.min(50, qty) } : l)),
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
      quantityOf: (menuItemId: string) =>
        lines.reduce((s, l) => (l.menuItemId === menuItemId ? s + l.quantity : s), 0),
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
