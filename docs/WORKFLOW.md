# Development Workflow (every coding session follows this)

This app is under **continuous, never-ending development**: 3–4 meaningful
increments per day, Monday to Saturday (no code on Sundays). Each session works
through this exact routine.

## Routine per session

1. `cd /home/ubuntu/foodorderapp`
2. `git pull --rebase origin master` (never start from a stale tree)
3. Read `docs/ROADMAP.md` — pick the **top unchecked, non-🔒 item** that is
   self-contained and testable within one session. Never pick multiple huge items.
4. Implement it fully: code + wire it in + update seed/docs/tests if relevant.
5. **Verify before committing** (no unverified claims):
   - API: `cd apps/api && npm run build && npm test`
   - Web: `cd apps/web && npm run build` (skip if only API changed, and vice versa)
   - If the stack is up (`docker compose ps` healthy), smoke-test the changed
     endpoint/page with `curl`.
6. Commit with conventional commits (`feat: …`, `fix: …`, `test: …`, `docs: …`,
   `refactor: …`, `chore: …`). Small focused commits are fine — 1–2 commits per session.
7. Append an entry to `docs/DEVLOG.md` (date, time slot, what/why, verification done)
   and tick the item in `docs/ROADMAP.md` (or add sub-items if partially done).
   Commit the docs together with, or right after, the code.
8. `git push origin master`
9. If the roadmap's current phase is fully green, add a new phase from the
   "Evergreen loops" section at the bottom — **the backlog must never be empty**.

## Quality rules

- Never fake progress: no empty/typo commits, no commented-out features.
- Never break what already works — if a change can't be verified green, revert
  and note it in DEVLOG instead.
- The agent transcript sanitizer rewrites literal credential patterns
  (`user:pass@host`, JSON password fields) typed in shell commands. Never paste
  secrets inline: read `DATABASE_URL` from the untracked `apps/api/.env`
  (ConfigModule loads it automatically) and pass other secrets via shell
  variables assigned in the same command.
- Keep `synchronize: true` only while schemas are fluid; introduce TypeORM
  migrations as soon as the schema-stability item is scheduled (roadmap tracks it).
- Money is integer cents everywhere. No float prices.
- All new endpoints: input validation via class-validator DTOs, tested via jest
  or curl. Note: with the global ValidationPipe (`whitelist: true`), every DTO
  property must carry at least one class-validator decorator or it gets stripped.

## When the session can't verify (e.g. docker unavailable)

Commit what is verified by build+unit tests only, mark the item as
`✅ built · ⏳ runtime-verified: no` in DEVLOG, and follow up the next session.

## Evergreen loops (generate more roadmap items from these when needed)

- Test coverage: unit → integration → e2e smoke suite per release
- Performance: query indexes → caching → bundle trimming
- Ops: migrations → logging → metrics → alerts → CI pipelines
- Product: each user-facing feature gets settings, analytics, polish passes
- UX: accessibility audit, empty states, loading states, mobile polish (repeats)
