import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddOrderStatusAudits1793865600000 implements MigrationInterface {
  name = 'AddOrderStatusAudits1793865600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "order_status_audits" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "orderId" uuid NOT NULL,
        "fromStatus" character varying(20) NOT NULL,
        "toStatus" character varying(20) NOT NULL,
        "source" character varying(24) NOT NULL,
        "actorUserId" uuid,
        "actorRole" character varying(20),
        "actorEmail" character varying(255),
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_order_status_audits_id" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_order_status_audits_from_status" CHECK ("fromStatus" IN ('pending','confirmed','preparing','delivering','completed','cancelled')),
        CONSTRAINT "CHK_order_status_audits_to_status" CHECK ("toStatus" IN ('pending','confirmed','preparing','delivering','completed','cancelled')),
        CONSTRAINT "CHK_order_status_audits_source" CHECK ("source" IN ('owner','admin','driver','customer','stale_sweep')),
        CONSTRAINT "CHK_order_status_audits_actor_role" CHECK ("actorRole" IS NULL OR "actorRole" IN ('customer','owner','admin','driver')),
        CONSTRAINT "FK_order_status_audits_orderId" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_order_status_audits_actorUserId" FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_order_status_audits_orderId_createdAt" ON "order_status_audits" ("orderId", "createdAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_order_status_audits_actorUserId" ON "order_status_audits" ("actorUserId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_order_status_audits_actorUserId"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_order_status_audits_orderId_createdAt"`);
    await queryRunner.query(`DROP TABLE "order_status_audits"`);
  }
}
