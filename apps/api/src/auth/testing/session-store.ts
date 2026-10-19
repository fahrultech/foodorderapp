import { FindOperator } from 'typeorm';

/**
 * Minimal in-memory stand-in for the `refresh_tokens` repository, used by the
 * auth specs. Understands exactly the four calls AuthService makes, including
 * the `IsNull()` where-operator (so the specs test the real query shape rather
 * than a hand-rolled approximation of it).
 */
export class SessionStore {
  rows: any[] = [];
  private seq = 0;

  constructor(seed: any[] = []) {
    this.rows = seed.map((r, i) => ({ id: r.id ?? `sess-pre-${i}`, revokedAt: null, ...r }));
  }

  get repo(): any {
    return {
      create: (partial: any) => ({ id: `sess-${++this.seq}`, revokedAt: null, ...partial }),
      save: async (entity: any) => {
        const i = this.rows.findIndex((r) => r.id === entity.id);
        if (i >= 0) this.rows[i] = entity;
        else this.rows.push(entity);
        return entity;
      },
      findOne: async ({ where }: any) => this.rows.find((r) => matches(r, where)) ?? null,
      update: async (where: any, data: any) => {
        const hits = this.rows.filter((r) => matches(r, where));
        hits.forEach((r) => Object.assign(r, data));
        return { affected: hits.length };
      },
    };
  }

  live() {
    return this.rows.filter((r) => !r.revokedAt);
  }

  byHash(tokenHash: string) {
    return this.rows.find((r) => r.tokenHash === tokenHash);
  }
}

function matches(row: any, where: any): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (value instanceof FindOperator) {
      return value.type === 'isNull' ? row[key] === null || row[key] === undefined : false;
    }
    return row[key] === value;
  });
}
