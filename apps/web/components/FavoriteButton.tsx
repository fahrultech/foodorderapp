'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useAuth } from '@/lib/auth';
import { useFavorites } from '@/lib/favorites';

/**
 * Heart toggle for one dish. Signed-in customers flip the server-backed state
 * (optimistic via FavoritesProvider). Guests get routed to /login with a
 * `next` back-pointer so they land back on the menu after signing in.
 * Server and first client paint both render the unfilled heart (`loaded` is
 * false until the fetch settles) — hydration-safe like the rest of the header.
 */
export default function FavoriteButton({ menuItemId }: { menuItemId: string }) {
  const { status } = useAuth();
  const { isFavorite, toggle } = useFavorites();
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const faved = isFavorite(menuItemId);

  async function onClick() {
    if (status !== 'signedIn') {
      router.push(`/login?next=${encodeURIComponent(window.location.pathname)}`);
      return;
    }
    if (pending) return;
    setPending(true);
    try {
      await toggle(menuItemId);
    } finally {
      setPending(false);
    }
  }

  return (
    <button
      onClick={onClick}
      aria-pressed={faved}
      aria-label={faved ? 'Remove from favorites' : 'Save to favorites'}
      title={status === 'signedIn' ? undefined : 'Sign in to save dishes'}
      className={
        `rounded-full p-2 text-xl leading-none transition hover:scale-110 ` +
        (faved ? 'text-brand-600' : 'text-stone-300 hover:text-brand-500')
      }
    >
      <span aria-hidden>{faved ? '♥' : '♡'}</span>
    </button>
  );
}
