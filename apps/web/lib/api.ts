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
};

export function formatPrice(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
