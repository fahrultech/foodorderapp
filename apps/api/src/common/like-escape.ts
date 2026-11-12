/**
 * Escape ILIKE/LIKE metacharacters. The backslash is the default LIKE escape
 * character; without this, a query like `50%` or `a_b` would match wildcards
 * instead of the literal text the user typed.
 *
 * Owned by `common` since session 79 — both `SearchService` (session 69) and
 * the `GET /restaurants` `search=` filter use it, so every public substring
 * surface has identical "what you type is what matches" semantics.
 */
export function escapeLike(q: string): string {
  return q.replace(/[\\%_]/g, (c) => `\\${c}`);
}
