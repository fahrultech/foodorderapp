'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { api, type PushConfig, type PushSubscriptionInput } from './api';
import { useAuth } from './auth';

type PushState =
  | 'loading'
  | 'off'
  | 'on'
  | 'working'
  | 'blocked'
  | 'unsupported'
  | 'unavailable'
  | 'error';

interface PushContextValue {
  state: PushState;
  error: string | null;
  enable: () => Promise<void>;
  disable: () => Promise<void>;
  disconnectBeforeLogout: () => Promise<void>;
}

const PushContext = createContext<PushContextValue | null>(null);

function browserSupportsPush(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

/** Convert the VAPID base64url key to the byte array PushManager expects. */
export function vapidKeyBytes(value: string): ArrayBuffer {
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
  const decoded = window.atob(base64);
  const bytes = Uint8Array.from(decoded, (char) => char.charCodeAt(0));
  return bytes.buffer as ArrayBuffer;
}

function subscriptionInput(subscription: PushSubscription): PushSubscriptionInput {
  const json = subscription.toJSON();
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;
  if (!json.endpoint || !p256dh || !auth) {
    throw new Error('Browser push subscription is missing encryption keys.');
  }
  return { endpoint: json.endpoint, keys: { p256dh, auth } };
}

async function currentSubscription(): Promise<PushSubscription | null> {
  const registration = await navigator.serviceWorker.getRegistration('/sw.js');
  return registration?.pushManager.getSubscription() ?? null;
}

export function PushNotificationsProvider({ children }: { children: React.ReactNode }) {
  const { status: authStatus, user, getAccessToken } = useAuth();
  const [state, setState] = useState<PushState>('loading');
  const [error, setError] = useState<string | null>(null);
  const configRef = useRef<PushConfig | null>(null);
  const loadSequence = useRef(0);

  const saveExisting = useCallback(
    async (subscription: PushSubscription) => {
      const token = await getAccessToken();
      if (!token) return false;
      await api.savePushSubscription(token, subscriptionInput(subscription));
      return true;
    },
    [getAccessToken],
  );

  useEffect(() => {
    const sequence = ++loadSequence.current;
    setError(null);

    if (authStatus === 'loading') {
      setState('loading');
      return;
    }
    if (authStatus !== 'signedIn' || !user) {
      configRef.current = null;
      setState('off');
      return;
    }
    if (!browserSupportsPush()) {
      setState('unsupported');
      return;
    }

    void (async () => {
      try {
        const config = await api.getPushConfig();
        if (sequence !== loadSequence.current) return;
        configRef.current = config;
        if (!config.enabled || !config.publicKey) {
          setState('unavailable');
          return;
        }
        if (Notification.permission === 'denied') {
          setState('blocked');
          return;
        }
        const existing = await currentSubscription();
        if (sequence !== loadSequence.current) return;
        if (!existing) {
          setState('off');
          return;
        }
        // Re-registering transfers a shared browser endpoint to the current JWT
        // subject and refreshes its keys without another permission prompt.
        await saveExisting(existing);
        if (sequence === loadSequence.current) setState('on');
      } catch (err) {
        if (sequence !== loadSequence.current) return;
        setError(err instanceof Error ? err.message : 'Could not load notification settings.');
        setState('error');
      }
    })();
  }, [authStatus, user?.id, saveExisting]);

  const enable = useCallback(async () => {
    const config = configRef.current;
    if (!browserSupportsPush()) {
      setState('unsupported');
      return;
    }
    if (!config?.enabled || !config.publicKey) {
      setState('unavailable');
      return;
    }

    setState('working');
    setError(null);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setState('blocked');
        return;
      }
      const registration = await navigator.serviceWorker.register('/sw.js');
      let subscription = await registration.pushManager.getSubscription();
      if (!subscription) {
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: vapidKeyBytes(config.publicKey),
        });
      }
      if (!(await saveExisting(subscription))) {
        throw new Error('Sign in again before enabling notifications.');
      }
      setState('on');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not enable notifications.');
      setState('error');
    }
  }, [saveExisting]);

  const removeSubscription = useCallback(async () => {
    if (!browserSupportsPush()) return;
    const subscription = await currentSubscription();
    if (!subscription) return;
    const token = await getAccessToken();
    try {
      if (token) await api.removePushSubscription(token, subscription.endpoint);
    } finally {
      // Local unsubscribe is the privacy boundary. If the API delete was
      // unreachable, the provider endpoint is invalid and the server's 410
      // cleanup removes the stale row on its next delivery attempt.
      await subscription.unsubscribe();
    }
  }, [getAccessToken]);

  const disable = useCallback(async () => {
    setState('working');
    setError(null);
    try {
      await removeSubscription();
      setState('off');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Notifications were disabled locally.');
      setState('off');
    }
  }, [removeSubscription]);

  const disconnectBeforeLogout = useCallback(async () => {
    try {
      await removeSubscription();
    } catch {
      // Signing out must not be blocked by notification cleanup. Local
      // unsubscribe still runs in removeSubscription's finally branch.
    }
  }, [removeSubscription]);

  return (
    <PushContext.Provider value={{ state, error, enable, disable, disconnectBeforeLogout }}>
      {children}
    </PushContext.Provider>
  );
}

export function usePushNotifications(): PushContextValue {
  const context = useContext(PushContext);
  if (!context) throw new Error('usePushNotifications must be used inside PushNotificationsProvider');
  return context;
}
