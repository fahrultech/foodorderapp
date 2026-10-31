import { expect, test, type Page } from '@playwright/test';

const AUTH_KEY = ['foodorder', 'auth', 'v1'].join('.');
const API_ORIGIN = 'http://localhost:4000';
const ENDPOINT = 'https://push.example.test/e2e-browser';
const PUBLIC_KEY = 'BEl62iUYgUivxIkv69yViEuiBIa40HI80E4K4mYHhVYZZFQTmGqZ6M2r9vKAjwR5_jkn7hqE8w7LJ3W6xG0w8oE';

async function installSignedInPushBrowser(page: Page) {
  await page.addInitScript(
    ({ authKey, endpoint }) => {
      localStorage.setItem(
        authKey,
        JSON.stringify({
          access_token: 'e2e-access',
          refresh_token: 'e2e-refresh',
          expires_at: Date.now() + 60 * 60 * 1000,
          user: {
            id: '00000000-0000-4000-8000-000000000001',
            email: 'push@foodorder.test',
            name: 'Push Customer',
            phone: null,
            address: null,
            role: 'customer',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        }),
      );

      let subscription: any = null;
      const calls = { permission: 0, subscribe: 0, unsubscribe: 0 };
      const makeSubscription = () => ({
        endpoint,
        toJSON: () => ({ endpoint, keys: { p256dh: 'p256dh-e2e', auth: 'auth-e2e' } }),
        unsubscribe: async () => {
          calls.unsubscribe += 1;
          subscription = null;
          return true;
        },
      });
      const registration = {
        pushManager: {
          getSubscription: async () => subscription,
          subscribe: async () => {
            calls.subscribe += 1;
            subscription = makeSubscription();
            return subscription;
          },
        },
      };

      Object.defineProperty(window, 'PushManager', { configurable: true, value: function PushManager() {} });
      Object.defineProperty(window, 'Notification', {
        configurable: true,
        value: {
          permission: 'default',
          requestPermission: async () => {
            calls.permission += 1;
            return 'granted';
          },
        },
      });
      Object.defineProperty(navigator, 'serviceWorker', {
        configurable: true,
        value: {
          register: async () => registration,
          getRegistration: async () => registration,
          ready: Promise.resolve(registration),
        },
      });
      (window as any).__pushCalls = calls;
    },
    { authKey: AUTH_KEY, endpoint: ENDPOINT },
  );
}

test('signed-in user opts in and out of browser notifications from a gesture', async ({ page }) => {
  await installSignedInPushBrowser(page);

  const writes: Array<{ method: string; body: any }> = [];
  await page.route(`${API_ORIGIN}/api/users/me/favorites`, (route) =>
    route.fulfill({ json: { items: [], total: 0 } }),
  );
  await page.route(`${API_ORIGIN}/api/notifications/push/**`, async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname.endsWith('/config')) {
      await route.fulfill({ json: { enabled: true, publicKey: PUBLIC_KEY } });
      return;
    }
    writes.push({ method: request.method(), body: request.postDataJSON() });
    await route.fulfill({ json: request.method() === 'DELETE' ? { removed: true } : { subscribed: true } });
  });

  await page.goto('/');
  await expect(page.getByText('Push Customer')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Enable notifications' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).__pushCalls.permission)).toBe(0);

  await page.getByRole('button', { name: 'Enable notifications' }).click();
  await expect(page.getByRole('button', { name: 'Disable notifications' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).__pushCalls.permission)).toBe(1);
  await expect.poll(() => page.evaluate(() => (window as any).__pushCalls.subscribe)).toBe(1);
  expect(writes).toEqual([
    {
      method: 'POST',
      body: { endpoint: ENDPOINT, keys: { p256dh: 'p256dh-e2e', auth: 'auth-e2e' } },
    },
  ]);

  await page.getByRole('button', { name: 'Disable notifications' }).click();
  await expect(page.getByRole('button', { name: 'Enable notifications' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).__pushCalls.unsubscribe)).toBe(1);
  expect(writes.at(-1)).toEqual({ method: 'DELETE', body: { endpoint: ENDPOINT } });

  await page.getByRole('button', { name: 'Enable notifications' }).click();
  await expect(page.getByRole('button', { name: 'Disable notifications' })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).__pushCalls.unsubscribe)).toBe(2);
  expect(writes.at(-1)).toEqual({ method: 'DELETE', body: { endpoint: ENDPOINT } });
});
