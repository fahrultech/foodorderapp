import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Receipt access proof (docs/ROADMAP.md Phase 6: `GET /orders/:id` ownership
 * fix). Until now the receipt route was readable by ANYONE who knew the order
 * uuid — a leaked link (email paste, referrer, shoulder-surf) exposed name,
 * phone and the full delivery address. `contactEmail` stores the address the
 * customer gives at checkout (normalized lowercase at the service layer);
 * a guest viewer must present it to unlock the receipt.
 *
 * NULL is legal: every pre-existing row plus guest orders placed by API
 * clients that omit the field. Those orders simply have no guest-view path —
 * the account owner (userId) and ADMIN keep access via the bearer path.
 */
export class AddOrderContactEmail1794553200000 implements MigrationInterface {
  name = 'AddOrderContactEmail1794553200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "orders" ADD COLUMN "contactEmail" character varying(254) NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "orders" DROP COLUMN "contactEmail"`,
    );
  }
}
