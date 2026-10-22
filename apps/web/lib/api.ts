export interface Restaurant {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  cuisine: string | null;
  city: string | null;
  address: string | null;
  imageUrl: string | null;
  rating: number;
  deliveryFeeCents: number;
  minOrderCents: number;
  avgPrepMinutes: number;
  isOpen: boolean;
  menuItems?: MenuItem[];
}

export interface MenuItem {
  id: string;
  name: string;
  description: string | null;
  priceCents: number;
  category: string | null;
  imageUrl: string | null;
  isAvailable: boolean;
  prepMinutes: number;
  restaurantId: string;
}

/**
 * Owner menu write payload. `POST /restaurants/:id/menu` takes the whole
 * shape; `PATCH /menu/items/:id` takes any subset. Optional text fields sent
 * as `null` explicitly CLEAR the value (class-validator @IsOptional skips
 * null/undefined and MenuService stores it). Money is integer cents — use
 * `parseMoneyToCents` for user input, never float math.
 */
export interface MenuItemInput {
  name: string;
  priceCents: number;
  description?: string | null;
  category?: string | null;
  imageUrl?: string | null;
  prepMinutes?: number;
  /** Create-only: start the dish hidden (draft). Updates go via the availability route. */
  isAvailable?: boolean;
}

export interface OrderLine {
  menuItemId: string;
  name: string;
  priceCents: number;
  quantity: number;
}

export interface CreateOrderPayload {
  restaurantId: string;
  items: { menuItemId: string; quantity: number }[];
  customerName: string;
  contactPhone: string;
  deliveryAddress: string;
  note?: string;
}

export interface Order {
  id: string;
  code: string;
  status: string;
  subtotalCents: number;
  deliveryFeeCents: number;
  totalCents: number;
  customerName: string;
  contactPhone: string;
  deliveryAddress: string;
  note: string | null;
  items: { id: string; name: string; quantity: number; unitPriceCents: number }[];
  restaurant?: Pick<Restaurant, 'id' | 'name' | 'imageUrl' | 'cuisine'>;
  createdAt: string;
}

/** Status values the API's OrderStatus enum accepts (see apps/api/src/orders/order.entity.ts). */
export const ORDER_STATUSES = [
  'pending',
  'confirmed',
  'preparing',
  'delivering',
  'completed',
  'cancelled',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** Statuses from which a customer may still cancel (mirrors STATUS_FLOW in the API). */
export const CANCELABLE_STATUSES: ReadonlySet<OrderStatus> = new Set([
  'pending',
  'confirmed',
  'preparing',
]);

/** Page envelope of GET /orders/my (same shape restaurants list uses, plus page/limit). */
export interface MyOrdersPage {
  items: Order[];
  total: number;
  page: number;
  limit: number;
}

/**
 * Envelope of GET /restaurants/:id/orders — owner inbox page. `counts` is a
 * per-status total over ALL statuses (not affected by the status filter), so
 * the dashboard tabs can show live badges.
 */
export interface RestaurantOrdersPage extends MyOrdersPage {
  counts: Record<OrderStatus, number>;
}

/** Client-facing user shape (matches `toSafeUser` on the API). */
export interface SafeUser {
  id: string;
  email: string;
  name: string;
  phone: string | null;
  address: string | null;
  role: string;
  createdAt: string;
  updatedAt: string;
}

/** Response of register/login/refresh — one auth session. */
export interface Session {
  access_token: string;
  refresh_token: string;
  token_type: string;
  /** Access-token lifetime in seconds. */
  expires_in: number;
  refresh_expires_at: string;
  user: SafeUser;
}

export interface RegisterInput {
  email: string;
  name: string;
  password: string;
  phone?: string;
  address?: string;
}

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api';
export { API_URL };

/** Error thrown by `request()` for non-2xx API responses. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
    cache: 'no-store',
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    // API error envelope: { error: { code, message, details } } (docs/ARCHITECTURE.md)
    const envelope = body?.error;
    const legacy = Array.isArray(body?.message) ? body.message.join('; ') : body?.message;
    throw new ApiError(
      envelope?.message || legacy || `API error ${res.status}`,
      res.status,
      envelope?.code,
      envelope?.details ?? null,
    );
  }
  return res.json() as Promise<T>;
}

/** Bearer header for the authed endpoints. */
function bearer(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}

/** True when an ApiError means "the access token is no longer accepted". */
export function isUnauthorized(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401;
}

export const api = {
  listRestaurants: (params: { search?: string; cuisine?: string } = {}) => {
    const qs = new URLSearchParams();
    if (params.search) qs.set('search', params.search);
    if (params.cuisine) qs.set('cuisine', params.cuisine);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return request<{ items: Restaurant[]; total: number }>(`/restaurants${suffix}`);
  },
  cuisines: () => request<string[]>('/restaurants/meta/cuisines'),
  getRestaurant: (id: string) => request<Restaurant>(`/restaurants/${id}`),
  createOrder: (payload: CreateOrderPayload) =>
    request<Order>('/orders', { method: 'POST', body: JSON.stringify(payload) }),
  getOrder: (id: string) => request<Order>(`/orders/${id}`),
  /**
   * Paginated order history for the signed-in customer. Server caps limit at
   * 50 and returns newest-first; `status` must be one of ORDER_STATUSES.
   */
  listMyOrders: (
    accessToken: string,
    params: { status?: OrderStatus; page?: number; limit?: number } = {},
  ) => {
    const qs = new URLSearchParams();
    if (params.status) qs.set('status', params.status);
    if (params.page) qs.set('page', String(params.page));
    if (params.limit) qs.set('limit', String(params.limit));
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return request<MyOrdersPage>(`/orders/my${suffix}`, { headers: bearer(accessToken) });
  },
  /** Self-cancel while the status machine allows it (pending/confirmed/preparing). */
  cancelOrder: (accessToken: string, id: string) =>
    request<Order>(`/orders/${id}/cancel`, { method: 'POST', headers: bearer(accessToken) }),
  // --- owner portal ---
  /** Restaurants owned by the signed-in owner (GET /restaurants/mine). */
  listMyRestaurants: (accessToken: string) =>
    request<Restaurant[]>('/restaurants/mine', { headers: bearer(accessToken) }),
  /**
   * Orders inbox for one of the caller's restaurants. The server 403s
   * restaurants the caller does not own (admins bypass); `status` must be one
   * of ORDER_STATUSES, limit is capped at 50 server-side.
   */
  listRestaurantOrders: (
    accessToken: string,
    restaurantId: string,
    params: { status?: OrderStatus; page?: number; limit?: number } = {},
  ) => {
    const qs = new URLSearchParams();
    if (params.status) qs.set('status', params.status);
    if (params.page) qs.set('page', String(params.page));
    if (params.limit) qs.set('limit', String(params.limit));
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return request<RestaurantOrdersPage>(
      `/restaurants/${restaurantId}/orders${suffix}`,
      { headers: bearer(accessToken) },
    );
  },
  /**
   * Owner status action — PATCH /restaurants/:rid/orders/:oid/status?status=.
   * Server enforces: JWT + owner role + the restaurant belongs to the caller
   * (admins bypass) + the order lives under that restaurant + STATUS_FLOW.
   * Illegal transition -> 400, foreign restaurant -> 403, wrong-path order -> 404.
   */
  setRestaurantOrderStatus: (
    accessToken: string,
    restaurantId: string,
    orderId: string,
    status: OrderStatus,
  ) =>
    request<Order>(
      `/restaurants/${restaurantId}/orders/${orderId}/status?status=${status}`,
      { method: 'PATCH', headers: bearer(accessToken) },
    ),

  // --- owner menu management ---
  /**
   * FULL dish list for a restaurant — the owner view. Public route, but the
   * storefront renders `GET /restaurants/:id` instead; this returns items in
   * ANY availability (drafts included), sorted category/name like the server.
   */
  listRestaurantMenu: (restaurantId: string) =>
    request<MenuItem[]>(`/restaurants/${restaurantId}/menu`),
  /** POST /restaurants/:restaurantId/menu — ownership enforced server-side. */
  createMenuItem: (accessToken: string, restaurantId: string, input: MenuItemInput) =>
    request<MenuItem>(`/restaurants/${restaurantId}/menu`, {
      method: 'POST',
      headers: bearer(accessToken),
      body: JSON.stringify(input),
    }),
  /** PATCH /menu/items/:id — only present keys change; availability lives on its own route. */
  updateMenuItem: (accessToken: string, itemId: string, patchBody: Partial<MenuItemInput>) =>
    request<MenuItem>(`/menu/items/${itemId}`, {
      method: 'PATCH',
      headers: bearer(accessToken),
      body: JSON.stringify(patchBody),
    }),
  /** PATCH /menu/items/:id/availability — first-class toggle. */
  setMenuItemAvailability: (accessToken: string, itemId: string, isAvailable: boolean) =>
    request<MenuItem>(`/menu/items/${itemId}/availability`, {
      method: 'PATCH',
      headers: bearer(accessToken),
      body: JSON.stringify({ isAvailable }),
    }),
  /**
   * DELETE /menu/items/:id — hard delete. Past orders keep name/price
   * snapshots (order_items FK is ON DELETE SET NULL), so history stays readable.
   */
  deleteMenuItem: (accessToken: string, itemId: string) =>
    request<MenuItem>(`/menu/items/${itemId}`, { method: 'DELETE', headers: bearer(accessToken) }),

  // --- auth ---
  register: (input: RegisterInput) =>
    request<Session>('/auth/register', { method: 'POST', body: JSON.stringify(input) }),
  login: (email: string, password: string) =>
    request<Session>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),
  /** Rotate the refresh token for a brand-new session (old token is single-use). */
  refresh: (refreshToken: string) =>
    request<Session>('/auth/refresh', {
      method: 'POST',
      body: JSON.stringify({ refresh_token: refreshToken }),
    }),
  me: (accessToken: string) => request<SafeUser>('/auth/me', { headers: bearer(accessToken) }),
  logout: (accessToken: string, refreshToken: string) =>
    request<{ success: boolean; revoked_sessions: number }>('/auth/logout', {
      method: 'POST',
      headers: bearer(accessToken),
      body: JSON.stringify({ refresh_token: refreshToken }),
    }),
};

export function formatPrice(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * Dollar string -> integer cents WITHOUT float math ("12", "12.5", "12.50"),
 * mirroring the API's priceCents bounds (1 … 10_000_000). Returns null for
 * anything the server would reject — the server stays the authority; this is
 * only for fast client feedback.
 */
export function parseMoneyToCents(raw: string): number | null {
  const s = raw.trim().replace(/\s+/g, '');
  if (!/^\d{1,8}(\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  const cents = Number(whole) * 100 + Number((frac + '00').slice(0, 2));
  return cents >= 1 && cents <= 10000000 ? cents : null;
}

/** Integer cents -> form input value ("1250" -> "12.50"). */
export function centsToInput(cents: number): string {
  return (cents / 100).toFixed(2);
}

