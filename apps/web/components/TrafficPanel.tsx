'use client';

import type { MetricsSnapshot } from '@/lib/api';

/**
 * Traffic & error-budget cards + per-route table for the ADMIN overview —
 * the dashboard stub on top of GET /admin/metrics (session 80's registry).
 *
 * Contract notes:
 * - The snapshot is CUMULATIVE SINCE API BOOT (no windows, no ring
 *   buffers — see common/metrics/request-metrics.ts). Numbers therefore
 *   only ever grow until the process restarts; the UI must not imply a
 *   time window.
 * - Percentiles are histogram BOUND estimates (nearest-rank over the
 *   cumulative buckets): the displayed ms is always >= the true latency.
 *   We surface them as "≤ bound" style estimates, never measured values.
 * - 4xx responses do NOT burn the error budget (client mistakes are not
 *   availability failures); only 5xx does. That is the whole alerting
 *   signal the metrics middleware records the status class for.
 */

/** Availability SLO the stub budgets against: at most 0.5% of responses 5xx. */
export const SLO_AVAILABILITY_TARGET_PCT = 99.5;
export const ERROR_BUDGET_PCT = 100 - SLO_AVAILABILITY_TARGET_PCT;

/** Table cap: registry may hold up to MAX_ROUTE_KEYS (250) + the overflow bucket. */
const MAX_VISIBLE_ROWS = 15;

function ms(value: number | null): string {
  return value === null ? '—' : `${value} ms`;
}

function pct(value: number | null, digits = 1): string {
  return value === null ? '—' : `${value.toFixed(digits)}%`;
}

function formatUptime(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m ${sec % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export interface ErrorBudget {
  /** 5xx share of all tracked responses, in percentage points; null = no samples yet. */
  errorRatePct: number | null;
  /** Fraction of the 0.5-point budget already burned; may exceed 100. */
  consumedPct: number | null;
  /** Percentage points of the budget still intact (never negative). */
  remainingPts: number | null;
  withinBudget: boolean;
}

/** Exported for unit specs — pure math over the snapshot totals. */
export function computeErrorBudget(snapshot: MetricsSnapshot): ErrorBudget {
  const { requests, byStatus } = snapshot.totals;
  if (requests <= 0) {
    return { errorRatePct: null, consumedPct: null, remainingPts: null, withinBudget: true };
  }
  const errorRatePct = (byStatus['5xx'] / requests) * 100;
  const consumedPct = (errorRatePct / ERROR_BUDGET_PCT) * 100;
  const remainingPts = Math.max(0, ERROR_BUDGET_PCT - errorRatePct);
  return { errorRatePct, consumedPct, remainingPts, withinBudget: consumedPct <= 100 };
}

function Card({
  label,
  value,
  detail,
  testId,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  detail: string;
  testId: string;
  tone?: 'neutral' | 'good' | 'bad';
}) {
  const valueTone =
    tone === 'bad' ? 'text-red-700' : tone === 'good' ? 'text-emerald-700' : 'text-stone-900';
  return (
    <article className="rounded-2xl border border-stone-200 bg-white p-5 shadow-sm" data-testid={testId}>
      <p className="text-xs font-bold uppercase tracking-[0.16em] text-stone-500">{label}</p>
      <p className={`mt-2 text-3xl font-black ${valueTone}`}>{value}</p>
      <p className="mt-1 text-sm text-stone-500">{detail}</p>
    </article>
  );
}

export default function TrafficPanel({ snapshot }: { snapshot: MetricsSnapshot }) {
  const totals = snapshot.totals;
  const budget = computeErrorBudget(snapshot);
  const visible = snapshot.routes.slice(0, MAX_VISIBLE_ROWS);
  const hiddenRows = Math.max(0, snapshot.routes.length - visible.length);

  return (
    <section className="mt-10" aria-labelledby="traffic-heading">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 id="traffic-heading" className="text-xl font-black text-stone-900">
          Traffic &amp; error budget
        </h2>
        <p className="text-xs text-stone-500">
          Cumulative since API boot · snapshot {new Date(snapshot.generatedAt).toLocaleTimeString()} · uptime{' '}
          {formatUptime(snapshot.uptimeSec)}
        </p>
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4" data-testid="traffic-cards">
        <Card
          label="Requests"
          value={totals.requests.toLocaleString()}
          detail={`${totals.routeKeys} route keys${totals.overflowed ? ' · cardinality cap hit (see "other")' : ''}`}
          testId="traffic-card-requests"
        />
        <Card
          label="Latency p95"
          value={ms(totals.p95Ms)}
          detail={`p50 ${ms(totals.p50Ms)} · p99 ${ms(totals.p99Ms)} · max ${ms(totals.maxMs)} (histogram estimates)`}
          testId="traffic-card-latency"
        />
        <Card
          label="Server errors"
          value={totals.byStatus['5xx'].toLocaleString()}
          detail={`${totals.byStatus['4xx']} 4xx client · ${pct(
            totals.requests > 0 ? (totals.byStatus['4xx'] / totals.requests) * 100 : null,
          )} of traffic (4xx does not burn the budget)`}
          testId="traffic-card-errors"
          tone={totals.byStatus['5xx'] > 0 ? 'bad' : 'neutral'}
        />
        <Card
          label="Error budget"
          value={budget.consumedPct === null ? '—' : pct(Math.min(budget.consumedPct, 9999), 0)}
          detail={
            budget.errorRatePct === null
              ? `No samples yet · budget intact · SLO ${SLO_AVAILABILITY_TARGET_PCT}% (${ERROR_BUDGET_PCT}% 5xx allowed)`
              : `5xx rate ${pct(budget.errorRatePct, 2)} vs ${ERROR_BUDGET_PCT}% budget · ${pct(
                  budget.remainingPts,
                  2,
                )} points left`
          }
          testId="traffic-card-budget"
          tone={budget.consumedPct === null ? 'neutral' : budget.withinBudget ? 'good' : 'bad'}
        />
      </div>

      <div className="mt-6 overflow-x-auto rounded-2xl border border-stone-200 bg-white shadow-sm" data-testid="traffic-route-table">
        <table className="min-w-full text-left text-sm">
          <caption className="sr-only">
            Per-route request counts, status classes and latency estimates, sorted by traffic
          </caption>
          <thead className="bg-stone-50 text-xs uppercase tracking-wide text-stone-500">
            <tr>
              <th scope="col" className="px-4 py-3">Route</th>
              <th scope="col" className="px-4 py-3 text-right">Requests</th>
              <th scope="col" className="px-4 py-3 text-right">2xx</th>
              <th scope="col" className="px-4 py-3 text-right">4xx</th>
              <th scope="col" className="px-4 py-3 text-right">5xx</th>
              <th scope="col" className="px-4 py-3 text-right">p50</th>
              <th scope="col" className="px-4 py-3 text-right">p95</th>
              <th scope="col" className="px-4 py-3 text-right">max</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100">
            {visible.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-6 text-center text-stone-500">
                  No tracked requests yet — /api/health probes are deliberately excluded.
                </td>
              </tr>
            )}
            {visible.map((row) => (
              <tr key={row.route}>
                <td className="whitespace-nowrap px-4 py-3 font-mono text-xs font-bold text-stone-900">{row.route}</td>
                <td className="px-4 py-3 text-right tabular-nums text-stone-900">{row.requests.toLocaleString()}</td>
                <td className="px-4 py-3 text-right tabular-nums text-stone-600">{row.byStatus['2xx'].toLocaleString()}</td>
                <td className="px-4 py-3 text-right tabular-nums text-stone-600">{row.byStatus['4xx'].toLocaleString()}</td>
                <td className={`px-4 py-3 text-right tabular-nums font-bold ${row.byStatus['5xx'] > 0 ? 'text-red-700' : 'text-stone-600'}`}>
                  {row.byStatus['5xx'].toLocaleString()}
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-stone-600">{ms(row.p50Ms)}</td>
                <td className="px-4 py-3 text-right tabular-nums text-stone-600">{ms(row.p95Ms)}</td>
                <td className="px-4 py-3 text-right tabular-nums text-stone-600">{ms(row.maxMs)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {hiddenRows > 0 && (
        <p className="mt-2 text-xs text-stone-500" data-testid="traffic-hidden-note">
          Showing the {MAX_VISIBLE_ROWS} busiest of {snapshot.routes.length} route keys (sorted by request count).
        </p>
      )}
    </section>
  );
}
