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
