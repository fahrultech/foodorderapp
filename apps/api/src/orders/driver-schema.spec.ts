import { getMetadataArgsStorage, QueryRunner } from 'typeorm';
import { UserRole } from '../users/user.entity';
import { Order } from './order.entity';
import { AddDriverAssignment1793664000000 } from '../database/migrations/1793664000000-AddDriverAssignment';

describe('driver assignment schema contract', () => {
  it('adds DRIVER to the application role enum', () => {
    expect(UserRole.DRIVER).toBe('driver');
  });

  it('maps nullable driverId plus a SET NULL user relation and index on orders', () => {
    const metadata = getMetadataArgsStorage();
    const column = metadata.columns.find(
      (entry) => entry.target === Order && entry.propertyName === 'driverId',
    );
    expect(column?.options.nullable).toBe(true);

    const relation = metadata.relations.find(
      (entry) => entry.target === Order && entry.propertyName === 'driver',
    );
    expect(relation?.relationType).toBe('many-to-one');
    expect(relation?.options).toMatchObject({ nullable: true, onDelete: 'SET NULL' });
    const join = metadata.joinColumns.find(
      (entry) => entry.target === Order && entry.propertyName === 'driver',
    );
    expect(join).toMatchObject({
      name: 'driverId',
      foreignKeyConstraintName: 'FK_orders_driverId_users_id',
    });

    const index = metadata.indices.find(
      (entry) => entry.target === Order && entry.name === 'IDX_orders_driverId',
    );
    expect(index?.columns).toEqual(['driverId']);
  });

  it('migration safely extends the existing enum and adds/removes column, index, FK', async () => {
    const queries: string[] = [];
    const runner = {
      query: jest.fn(async (sql: string) => {
        queries.push(sql);
      }),
    } as unknown as QueryRunner;
    const migration = new AddDriverAssignment1793664000000();

    await migration.up(runner);
    expect(queries.join('\n')).toContain(
      `ALTER TYPE "public"."users_role_enum" ADD VALUE IF NOT EXISTS 'driver'`,
    );
    expect(queries.join('\n')).toContain('ADD "driverId" uuid');
    expect(queries.join('\n')).toContain('CREATE INDEX "IDX_orders_driverId"');
    expect(queries.join('\n')).toContain('ON DELETE SET NULL');

    queries.length = 0;
    await migration.down(runner);
    expect(queries.join('\n')).toContain('DROP CONSTRAINT');
    expect(queries.join('\n')).toContain('DROP INDEX');
    expect(queries.join('\n')).toContain('DROP COLUMN "driverId"');
    expect(queries.join('\n')).not.toContain('DROP TYPE');
  });
});
