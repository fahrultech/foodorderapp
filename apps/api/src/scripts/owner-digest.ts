import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { QueryFailedError } from 'typeorm';
import { AppDataSource } from '../database/data-source';
import { MailService } from '../notifications/mail.service';
import { OwnerDigestLog } from '../notifications/owner-digest-log.entity';
import { Order, OrderStatus } from '../orders/order.entity';
import { OrderItem } from '../orders/order-item.entity';
import { Restaurant } from '../restaurants/restaurant.entity';
import { User } from '../users/user.entity';
import {
  resolveDigestConfig,
  runOwnerDigest,
  type DigestLogRow,
  type DishSaleRow,
  type OwnerDigestPorts,
  type OwnerRestaurantRow,
  type RestaurantStatRow,
} from '../notifications/owner-digest';

/**
 * Standalone cron runner for the OWNER DAILY DIGEST (roadmap Phase 17,
 * Product loop): emails each restaurant owner yesterday's order counts,
 * completed revenue (cents) and top dishes per owned restaurant.
 *
 * This is the process a scheduler invokes (see ops/owner-digest.sh + the
 * systemd timer under ops/systemd/). It boots the TypeORM DataSource
 * directly (migrationsRun applies the digest ledger first), adapts the
 * narrow owner-digest ports onto real repositories + MailService, and runs
 * the SAME shared `runOwnerDigest` core the unit specs pin — one
 * implementation, no drift (the in-app HTTP surface deliberately has NO
 * digest route: this is a push artifact, not a pull dashboard).
 *
 * Config comes from the environment (never inline secrets):
 *   DATABASE_URL                   connection string (apps/api/.env via dotenv)
 *   SMTP_* / SMTP_JSON_CAPTURE     MailService rig + delivery (see mail.service.ts)
 *   DIGEST_DATE                    covered day YYYY-MM-DD (default: yesterday, local)
 *   DIGEST_DRY_RUN=1               compute + report, claim nothing, send nothing
 *   DIGEST_CLAIM_STALE_MINUTES     crashed-claim take-over window (default 30)
 *
 * Exit codes: 0 ok (skips included) · 1 error (config/DB) or ANY failed send
 * (the claim was released, so the next tick retries — a non-zero exit is the
 * cron's alerting hook).
 */

const isUniqueViolation = (err: unknown): boolean => {
  if (!(err instanceof QueryFailedError)) return false;
  const code = (err as QueryFailedError & { code?: string }).code
    ?? (err as { driverError?: { code?: string } }).driverError?.code;
  return code === '23505';
};

async function main(): Promise<number> {
  const config = resolveDigestConfig();
  await AppDataSource.initialize();

  const orders = AppDataSource.getRepository(Order);
  const orderItems = AppDataSource.getRepository(OrderItem);
  const restaurants = AppDataSource.getRepository(Restaurant);
  const digestLogs = AppDataSource.getRepository(OwnerDigestLog);
  const mail = new MailService(new ConfigService());
  const now = () => new Date();

  const ports: OwnerDigestPorts = {
    async listOwnerRestaurants(): Promise<OwnerRestaurantRow[]> {
      const rows = await restaurants
        .createQueryBuilder('r')
        .innerJoin(User, 'u', 'u.id = r.ownerId')
        .select('r.id', 'restaurantId')
        .addSelect('r.name', 'restaurantName')
        .addSelect('u.id', 'ownerId')
        .addSelect('u.email', 'ownerEmail')
        .addSelect('u.name', 'ownerName')
        .addSelect('u.orderEmailEnabled', 'orderEmailEnabled')
        .where('r.ownerId IS NOT NULL')
        .orderBy('u.id', 'ASC')
        .addOrderBy('r.name', 'ASC')
        .getRawMany<Record<string, unknown>>();
      return rows.map((row) => ({
        ownerId: String(row.ownerId),
        ownerEmail: String(row.ownerEmail),
        ownerName: String(row.ownerName),
        orderEmailEnabled: row.orderEmailEnabled !== false,
        restaurantId: String(row.restaurantId),
        restaurantName: String(row.restaurantName),
      }));
    },

    async orderStats(start, end, restaurantIds): Promise<RestaurantStatRow[]> {
      const rows = await orders
        .createQueryBuilder('o')
        .select('o.restaurantId', 'restaurantId')
        .addSelect('COUNT(*)', 'orderCount')
        // NB: ':name' tokens inside select() expressions are NOT bound by
        // TypeORM (only where-clauses are) — these CASE arms carry the
        // OrderStatus string LITERALS, kept in lockstep by the enum import.
        .addSelect(`SUM(CASE WHEN o.status = '${OrderStatus.COMPLETED}' THEN 1 ELSE 0 END)`, 'completedCount')
        .addSelect(`SUM(CASE WHEN o.status = '${OrderStatus.CANCELLED}' THEN 1 ELSE 0 END)`, 'cancelledCount')
        .addSelect(
          `COALESCE(SUM(CASE WHEN o.status = '${OrderStatus.COMPLETED}' THEN o.totalCents ELSE 0 END), 0)`,
          'revenueCents',
        )
        .where('o.createdAt >= :start AND o.createdAt < :end')
        .andWhere('o.restaurantId IN (:...ids)')
        .setParameters({ start, end, ids: restaurantIds })
        .groupBy('o.restaurantId')
        .getRawMany<Record<string, unknown>>();
      return rows.map((row) => ({
        restaurantId: String(row.restaurantId),
        orderCount: Number(row.orderCount) || 0,
        completedCount: Number(row.completedCount) || 0,
        cancelledCount: Number(row.cancelledCount) || 0,
        revenueCents: Number(row.revenueCents) || 0,
      }));
    },

    async dishSales(start, end, restaurantIds): Promise<DishSaleRow[]> {
      const rows = await orderItems
        .createQueryBuilder('oi')
        .innerJoin('oi.order', 'o')
        .select('o.restaurantId', 'restaurantId')
        .addSelect('oi.name', 'name')
        .addSelect('SUM(oi.quantity)', 'quantity')
        .where('o.createdAt >= :start AND o.createdAt < :end')
        .andWhere('o.restaurantId IN (:...ids)')
        .andWhere('o.status != :cancelled')
        .setParameters({ start, end, ids: restaurantIds, cancelled: OrderStatus.CANCELLED })
        .groupBy('o.restaurantId')
        .addGroupBy('oi.name')
        .getRawMany<Record<string, unknown>>();
      return rows.map((row) => ({
        restaurantId: String(row.restaurantId),
        name: String(row.name),
        quantity: Number(row.quantity) || 0,
      }));
    },

    async findDigestRows(digestDate): Promise<DigestLogRow[]> {
      const rows = await digestLogs.find({ where: { digestDate } });
      return rows.map((r) => ({
        id: r.id,
        ownerId: r.ownerId,
        digestDate: String(r.digestDate),
        restaurantCount: r.restaurantCount,
        orderCount: r.orderCount,
        revenueCents: r.revenueCents,
        claimedAt: new Date(r.claimedAt),
        sentAt: r.sentAt ? new Date(r.sentAt) : null,
      }));
    },

    async claimDigest(row) {
      const id = randomUUID();
      try {
        await digestLogs.insert({ id, ...row, sentAt: null });
      } catch (err: unknown) {
        if (isUniqueViolation(err)) return null; // someone else claimed today
        throw err;
      }
      return { id, sentAt: null, ...row };
    },

    async refreshClaim(id, stats, claimedAt) {
      await digestLogs.update(
        { id },
        { ...stats, claimedAt, sentAt: null },
      );
    },

    async markSent(id, sentAt) {
      await digestLogs.update({ id }, { sentAt });
    },

    async releaseClaim(id) {
      await digestLogs.delete({ id });
    },

    async sendMail(to, subject, text) {
      return mail.send({ to, subject, text }, 'general');
    },

    now,
  };

  const report = await runOwnerDigest(ports, config);
  console.log(JSON.stringify(report));
  return report.totals.failed > 0 ? 1 : 0;
}

main()
  .then((code) => (AppDataSource.isInitialized ? AppDataSource.destroy() : undefined)
    .then(() => process.exit(code)))
  .catch(async (err: unknown) => {
    console.error(`owner-digest: ${err instanceof Error ? err.message : String(err)}`);
    if (AppDataSource.isInitialized) await AppDataSource.destroy();
    process.exit(1);
  });
