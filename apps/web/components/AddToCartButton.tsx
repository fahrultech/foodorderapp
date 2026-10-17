'use client';

import { useState } from 'react';
import type { MenuItem, Restaurant } from '@/lib/api';
import { useCart } from '@/lib/cart';

export default function AddToCartButton({
  item,
  restaurant,
}: {
  item: MenuItem;
  restaurant: Pick<Restaurant, 'id' | 'name'>;
}) {
  const { add, lines } = useCart();
  const [added, setAdded] = useState(false);
  const inCart = lines.find((l) => l.menuItemId === item.id);

  function onClick() {
    add(item, restaurant);
    setAdded(true);
    setTimeout(() => setAdded(false), 900);
  }

  return (
    <button
      onClick={onClick}
      disabled={!item.isAvailable}
      className="rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:bg-stone-300"
    >
      {!item.isAvailable ? 'Unavailable' : added ? 'Added ✓' : inCart ? `Add (${inCart.quantity} in cart)` : 'Add'}
    </button>
  );
}
