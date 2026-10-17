# ARCHITECTURE

## System

```
Browser ──▶ Next.js web (SSR for browse pages, client for cart/checkout)
               │  REST JSON  (NEXT_PUBLIC_API_URL)
               ▼
          NestJS API ──▶ PostgreSQL (TypeORM, synchronize=true dev / migrations prod)
               ▲
   docker compose: db (postgres:16-alpine) + api + web
```

## Decisions

- **Monorepo `apps/`** — one repo, two deployables; shared git history for the
  daily-progress cadence (see docs/WORKFLOW.md).
- **Money as integer cents** — every price/fee/total is `int` cents; formatting
  only at the UI edge. Avoids float drift in totals.
- **Server-side pricing** — order totals are computed from DB menu prices at
  checkout, never trusted from the client. Cart contents only send `menuItemId`s.
- **One-restaurant carts** — a cart holds dishes from a single restaurant
  (matches delivery/logic reality); switching restaurants clears via the cart rule.
- **Order status machine** — transitions validated server-side
  (`pending→confirmed→preparing→delivering→completed`, cancellable through preparing).
- **JWT (7d) + custom guard** — no passport for now; the guard verifies Bearer
  tokens and decorates `req.user` with `{sub, email, role, name}`.
- **Snapshot order items** — `order_items` store name+unit price copies, so
  historical orders survive menu edits.
- **TypeORM synchronize in dev** — quick schema iteration; baseline migrations
  are scheduled in ROADMAP Phase 1 before schema hardening.

## Data model (v0)

users(1)──(N)orders(1)──(N)order_items(N)──(1)menu_items(N)──(1)restaurants

Roles: `customer` (default), `owner`, `admin`.
