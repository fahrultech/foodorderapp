# 🍜 FoodOrder

A real, functional food-ordering platform built with:

- **Frontend:** Next.js 15 (App Router, TypeScript, Tailwind CSS)
- **Backend:** NestJS 11 (TypeORM, JWT auth, class-validator)
- **Database:** PostgreSQL 16
- **Infra:** Docker + docker compose

## Quick start (Docker)

```bash
cp .env.example .env
docker compose up --build
```

- Web: http://localhost:3000
- API: http://localhost:4000/api
- Health: http://localhost:4000/api/health

Seed the demo data (restaurants, menus, demo users):

```bash
docker compose exec api npm run seed
```

Demo logins: `demo@foodorder.app` / `demo1234` (customer) and
`owner@foodorder.app` / `demo1234` (owns Warung Nusantara + Seoul Street).

Accounts work end-to-end on the storefront: `/login` and `/register` sign you
in (session kept in the browser, refreshed automatically), and the header shows
who is signed in. Owner accounts also get a portal — `/dashboard` (order inbox
with accept/prepare/deliver/complete/cancel actions, live-updating via an SSE
push stream — with the 10s poll kept as automatic fallback — plus NEW badges
and a pause toggle) and `/dashboard/menu`
(add, edit, hide and delete dishes) — both gated server-side by JWT + owner
role + restaurant ownership, not just by the UI.

Every restaurant page has instant in-page menu search (matches dish name,
description or category) with a live match count, plus a sticky category
anchor bar for jumping between menu sections — all client-side, no server
round-trip per keystroke.

## Local development (no Docker)

```bash
# 1. Database — any PostgreSQL 14+ instance
createdb foodorder

# 2. API
cd apps/api && npm install
DATABASE_URL=postgresql://user:***@localhost:5432/foodorder npm run start:dev

# 3. Web
cd apps/web && npm install
NEXT_PUBLIC_API_URL=http://localhost:4000/api npm run dev
```

## API surface (v0)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | Liveness + DB status |
| GET | `/api/restaurants` | List (search, cuisine, city, sort, page) |
| GET | `/api/restaurants/meta/cuisines` | Distinct cuisines |
| GET | `/api/restaurants/:id` | Restaurant + menu |
| GET | `/api/restaurants/:id/menu` | Menu only |
| POST | `/api/auth/register` | Create account → access + refresh token |
| POST | `/api/auth/login` | Login → access + refresh token |
| POST | `/api/auth/refresh` | Rotate a refresh token → new session |
| POST | `/api/auth/logout` | Revoke this session, or all of mine (Bearer) |
| GET | `/api/auth/me` | Current profile (Bearer, read from DB) |
| PATCH | `/api/users/me` | Update own name/phone/address (Bearer) |
| GET | `/api/users/me/favorites` | Saved dishes, newest first (Bearer) — `{items,total}` with dish + restaurant fields |
| POST | `/api/users/me/favorites` | Heart a dish `{menuItemId}` (Bearer) — idempotent: 200 `{created:false}` if already saved; unknown dish 404 |
| DELETE | `/api/users/me/favorites/:menuItemId` | Un-heart (Bearer) — idempotent `{removed:true/false}` |
| POST | `/api/restaurants` | Create own restaurant (owner) |
| PATCH | `/api/restaurants/:id` | Edit own restaurant (owner) |
| GET | `/api/restaurants/mine` | Owner's restaurants |
| GET | `/api/restaurants/:id/orders` | Owner orders inbox (Bearer, owner role) — `?status=&page=&limit=`, returns `{items,total,page,limit,counts}`; ownership enforced server-side (403 for foreign restaurants, admins bypass) |
| GET | `/api/restaurants/:id/orders/stream` | SSE live order stream (owner role; Bearer header **or** `?access_token=` for EventSource) — `hello` / `order.created` / `order.updated` / `ping` events; trigger-only payloads, same ownership rules as the inbox |
| PATCH | `/api/restaurants/:id/orders/:orderId/status?status=` | Owner status action (Bearer, owner role) — accept / start / deliver / complete / cancel; 404 if the order lives under another restaurant, 400 for non-`STATUS_FLOW` moves or junk status values |
| POST | `/api/restaurants/:restaurantId/menu` | Add dish (owner) |
| PATCH | `/api/menu/items/:id` | Edit dish (owner) |
| PATCH | `/api/menu/items/:id/availability` | Toggle availability (owner) |
| DELETE | `/api/menu/items/:id` | Delete dish (owner) |
| POST | `/api/orders` | Place order — guest, or attached to the user when a valid Bearer token is sent |
| GET | `/api/orders/:id` | Order detail + status + status-step timestamps (`confirmedAt`/`preparingAt`/`deliveringAt`/`completedAt`/`cancelledAt`, null until reached) |
| GET | `/api/orders/my` | My orders (Bearer) — `?status=&page=&limit=`, returns `{items,total,page,limit}`; rows include restaurant + line items |
| POST | `/api/orders/:id/cancel` | Customer cancels own order (Bearer) — allowed through `preparing` |
| PATCH | `/api/orders/:id/status?status=` | Status machine transition — **admin only** (Bearer); owner actions go through the restaurant-scoped route above |

Order status machine: `pending → confirmed → preparing → delivering → completed` (cancellable until preparing).

### Error envelope

Every non-2xx API response has exactly one shape (global `ErrorFormatFilter`):

```json
{ "error": { "code": "NOT_FOUND", "message": "Order not found", "details": null } }
```

- `code` — stable machine code. Derived from status (`BAD_REQUEST`, `UNAUTHORIZED`,
  `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `INTERNAL_SERVER_ERROR`, …, `HTTP_<n>` for
  the rest); domain exceptions can carry a more specific one (e.g. `MIN_ORDER_NOT_MET`).
- `message` — human-readable; localized later.
- `details` — `null`, or a `string[]` of validation constraints when
  `message` is `"Validation failed"`, or a structured object for codes that
  ship facts (e.g. `{minimumCents, subtotalCents}`).
- Unexpected errors return a sanitized 500 — internals are logged server-side only.

## Repo layout

```
apps/api           NestJS backend
apps/web           Next.js storefront
docs/              roadmap, devlog, workflow, architecture
docker-compose.yml db + api + web
```

## Continuous development

This project is developed in ongoing daily increments. See
`docs/WORKFLOW.md` for the per-session routine and `docs/ROADMAP.md` for the
evergreen backlog; every pushed commit appends to `docs/DEVLOG.md`.
