'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { api } from './api';
import type { FavoriteDish } from './api';
import { authedCall } from './authed-call';
import { useAuth } from './auth';

/**
 * Per-session set of hearted dishes, loaded once from `/users/me/favorites`
 * and kept in sync optimistically. Mounted app-wide (layout) so the hearts on
 * restaurant menus and the `/favorites` page always show the same state
 * without refetching per component. Guests get an empty set; toggling while
 * signed out is the button's problem (it routes to /login instead).
 */

interface FavoritesContextValue {
  /** Server state has been fetched at least once for the current user. */
  loaded: boolean;
  /** All favorite rows, newest first (drives the /favorites page). */
  items: FavoriteDish[];
  isFavorite: (menuItemId: string) => boolean;
  /**
   * Heart/un-heart. Optimistic: flips immediately, rolls back and refetches
   * if the server disagrees. Resolves to the new state (false on rollback).
   */
  toggle: (menuItemId: string) => Promise<boolean>;
  refresh: () => Promise<void>;
}

const FavoritesContext = createContext<FavoritesContextValue | null>(null);

export function FavoritesProvider({ children }: { children: React.ReactNode }) {
  const { status, user, getAccessToken, logout } = useAuth();
  const signedIn = status === 'signedIn' && !!user;

  const [items, setItems] = useState<FavoriteDish[]>([]);
  const [loaded, setLoaded] = useState(false);
  // Requests in flight per dish id — double-clicks never stack a POST+DELETE.
  const busy = useRef<Set<string>>(new Set());
  // Load token: bump on logout/user switch so a slow response for the
  // previous user can never overwrite the new one's set.
  const loadSeq = useRef(0);

  const refresh = useCallback(async () => {
    if (!signedIn) {
      loadSeq.current += 1;
      setItems([]);
      setLoaded(true);
      return;
    }
    const seq = ++loadSeq.current;
    const res = await authedCall(getAccessToken, logout, (t) => api.listMyFavorites(t));
    if (seq !== loadSeq.current) return; // a newer load/user switch won
    if (res.ok) setItems(res.data.items);
    setLoaded(true);
  }, [signedIn, user?.id, getAccessToken, logout]);

  useEffect(() => {
    if (status === 'loading') return; // don't paint guest state during bootstrap
    void refresh();
  }, [status, refresh]);

  const ids = useMemo(() => new Set(items.map((i) => i.menuItemId)), [items]);

  const isFavorite = useCallback((menuItemId: string) => ids.has(menuItemId), [ids]);

  const toggle = useCallback(
    async (menuItemId: string): Promise<boolean> => {
      const was = ids.has(menuItemId);
      if (busy.current.has(menuItemId)) return was;
      busy.current.add(menuItemId);

      // Optimistic flip so the heart responds instantly.
      const apply = (favorited: boolean) => {
        setItems((prev) =>
          favorited
            ? prev
            : prev.filter((i) => i.menuItemId !== menuItemId),
        );
      };
      apply(!was);
      try {
        type ToggleResult = { kind: 'added'; item: FavoriteDish } | { kind: 'removed' };
        const res = await authedCall<ToggleResult>(getAccessToken, logout, async (t) => {
          if (was) {
            await api.removeFavorite(t, menuItemId);
            return { kind: 'removed' };
          }
          const added = await api.addFavorite(t, menuItemId);
          return { kind: 'added', item: added.item };
        });
        if (res.ok) {
          // Add: server gave back the full row (fresh favoritedAt) — merge it.
          // Remove: the optimistic filter already did the job.
          if (res.data.kind === 'added') {
            const item = res.data.item;
            setItems((prev) => [item, ...prev.filter((i) => i.menuItemId !== menuItemId)]);
          }
          return !was;
        }
        // signedOut / API error: undo the flip and resync from the server.
        apply(was);
        void refresh();
        return was;
      } finally {
        busy.current.delete(menuItemId);
      }
    },
    [ids, getAccessToken, logout, refresh],
  );

  const value = useMemo(
    () => ({ loaded, items, isFavorite, toggle, refresh }),
    [loaded, items, isFavorite, toggle, refresh],
  );

  return <FavoritesContext.Provider value={value}>{children}</FavoritesContext.Provider>;
}

export function useFavorites(): FavoritesContextValue {
  const ctx = useContext(FavoritesContext);
  if (!ctx) throw new Error('useFavorites must be used under <FavoritesProvider>');
  return ctx;
}
