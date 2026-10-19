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

Demo login: `demo@foodorder.app` / `demo1234`

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
| POST | `/api/restaurants` | Create own restaurant (owner) |
| PATCH | `/api/restaurants/:id` | Edit own restaurant (owner) |
| GET | `/api/restaurants/mine` | Owner's restaurants |
| POST | `/api/restaurants/:restaurantId/menu` | Add dish (owner) |
| PATCH | `/api/menu/items/:id` | Edit dish (owner) |
| PATCH | `/api/menu/items/:id/availability` | Toggle availability (owner) |
| DELETE | `/api/menu/items/:id` | Delete dish (owner) |
| POST | `/api/orders` | Place order — guest, or attached to the user when a valid Bearer token is sent |
| GET | `/api/orders/:id` | Order detail + status |
| GET | `/api/orders/my` | My orders (Bearer) — `?status=&page=&limit=`, returns `{items,total,page,limit}` |
| POST | `/api/orders/:id/cancel` | Customer cancels own order (Bearer) — allowed through `preparing` |
| PATCH | `/api/orders/:id/status?status=` | Status machine transition |

Order status machine: `pending → confirmed → preparing → delivering → completed` (cancellable until preparing).

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
