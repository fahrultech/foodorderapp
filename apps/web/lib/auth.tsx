'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { ApiError, api, isUnauthorized } from './api';
import type { RegisterInput, SafeUser, Session } from './api';

/**
 * Client-side auth session. The API hands out a short-lived JWT access token
 * plus an opaque single-use refresh token (rotated on every refresh — see
 * apps/api/src/auth/auth.service.ts). We persist both to localStorage, refresh
 * proactively before the access token dies, and fall back to guest on any
 * terminal 401 so the storefront keeps working without an account.
 */

const STORAGE_KEY = ['foodorder', 'auth', 'v1'].join('.');
/** Refresh this far ahead of access-token expiry (ms). */
const REFRESH_SKEW_MS = 60_000;
/** Retry delay after a failed (non-401) refresh attempt (ms). */
const REFRESH_RETRY_MS = 30_000;

interface StoredSession {
  access_token: string;
  refresh_token: string;
  /** Epoch ms when `access_token` stops being accepted. */
  expires_at: number;
  user: SafeUser;
}

type AuthStatus = 'loading' | 'signedIn' | 'guest';

interface AuthContextValue {
  status: AuthStatus;
  user: SafeUser | null;
  /** Fresh access token, refreshing transparently when close to expiry. */
  getAccessToken: () => Promise<string | null>;
  login: (email: string, password: string) => Promise<void>;
  register: (input: RegisterInput) => Promise<void>;
  /** Best-effort server-side revocation, always clears locally. */
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function readStored(): StoredSession | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (
      typeof s?.access_token === 'string' &&
      typeof s?.refresh_token === 'string' &&
      typeof s?.expires_at === 'number' &&
      s?.user &&
      typeof s.user.id === 'string'
    ) {
      return s as StoredSession;
    }
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* corrupt session -> guest */
  }
  return null;
}

function toStored(session: Session): StoredSession {
  return {
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_at: Date.now() + session.expires_in * 1000,
    user: session.user,
  };
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [session, setSession] = useState<StoredSession | null>(null);
  // Mirrors state for async callbacks that must never read a stale closure.
  const sessionRef = useRef<StoredSession | null>(null);
  const refreshInFlight = useRef<Promise<boolean> | null>(null);

  const applySession = useCallback((next: StoredSession | null) => {
    sessionRef.current = next;
    setSession(next);
    setStatus(next ? 'signedIn' : 'guest');
    try {
      if (next) localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      else localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* storage full/blocked: in-memory session still works for this tab */
    }
  }, []);

  /** Rotate the refresh token. True = new session stored, false = still valid, threw only on network errors. */
  const doRefresh = useCallback(async (): Promise<boolean> => {
    const current = sessionRef.current;
    if (!current) return false;
    if (refreshInFlight.current) return refreshInFlight.current;
    const p = (async (): Promise<boolean> => {
      try {
        const fresh = await api.refresh(current.refresh_token);
        applySession(toStored(fresh));
        return true;
      } catch (err) {
        if (isUnauthorized(err)) {
          // Revoked/expired/rotated-elsewhere — this device is signed out.
          applySession(null);
          return false;
        }
        throw err;
      } finally {
        refreshInFlight.current = null;
      }
    })();
    refreshInFlight.current = p;
    return p;
  }, [applySession]);

  // Hydrate from localStorage once mounted; never during SSR (hydration-safe:
  // both server and first client render start as 'loading').
  useEffect(() => {
    const stored = readStored();
    if (!stored) {
      setStatus('guest');
      return;
    }
    sessionRef.current = stored;
    setSession(stored);
    setStatus('signedIn');
    if (stored.expires_at - Date.now() < REFRESH_SKEW_MS) {
      // Token expired (or nearly) while the tab was closed. Failure is fine:
      // the proactive-refresh timer below will retry and clear on 401.
      void doRefresh().catch(() => {});
    }
  }, [doRefresh]);

  // Proactive refresh: wake shortly before expiry, retry on network failure.
  useEffect(() => {
    if (!session) return;
    const delay = Math.max(session.expires_at - Date.now() - REFRESH_SKEW_MS, 0);
    const timer = setTimeout(() => {
      void doRefresh().catch(() => {
        // Network hiccup: try again once soon; a terminal 401 clears inside doRefresh.
        if (sessionRef.current) {
          setTimeout(() => void doRefresh().catch(() => {}), REFRESH_RETRY_MS);
        }
      });
    }, delay);
    return () => clearTimeout(timer);
  }, [session, doRefresh]);

  const getAccessToken = useCallback(async (): Promise<string | null> => {
    let current = sessionRef.current;
    if (!current) return null;
    if (current.expires_at - Date.now() < REFRESH_SKEW_MS) {
      try {
        await doRefresh();
      } catch {
        /* offline: fall through with the (possibly stale) token below */
      }
      current = sessionRef.current;
      if (!current) return null;
    }
    return current.access_token;
  }, [doRefresh]);

  const login = useCallback(
    async (email: string, password: string) => {
      const s = await api.login(email.trim(), password);
      applySession(toStored(s));
    },
    [applySession],
  );

  const register = useCallback(
    async (input: RegisterInput) => {
      const s = await api.register({
        ...input,
        email: input.email.trim(),
        name: input.name.trim(),
        phone: input.phone?.trim() || undefined,
        address: input.address?.trim() || undefined,
      });
      applySession(toStored(s));
    },
    [applySession],
  );

  const logout = useCallback(async () => {
    const current = sessionRef.current;
    if (current) {
      try {
        await api.logout(current.access_token, current.refresh_token);
      } catch (err) {
        // Even a dead access token can't block local sign-out.
        if (!(err instanceof ApiError)) throw err;
      }
    }
    applySession(null);
  }, [applySession]);

  return (
    <AuthContext.Provider
      value={{ status, user: session?.user ?? null, getAccessToken, login, register, logout }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
