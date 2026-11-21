'use client';

import { useTranslations } from 'next-intl';
import type { AlertsHistory, AlertVerdictRecord } from '@/lib/api';

/**
 * Alert-history panel (Phase 11 web side of session 112's persisted verdict
 * series) — the error-budget-style sibling of TrafficPanel on /admin.
 *
 * Contract notes (the payload is GET /admin/alerts/history):
 * - The streak counts the LIVE engine verdict of THIS read on top of the
 *   persisted trailing run (alert-scan escalation gate semantics), so the
 *   big number is "consecutive alerting evaluations incl. this read", not a
 *   window statistic. `trailingCapped` makes the persisted half a LOWER
 *   bound — surfaced as "≥", never as an exact count.
 * - `enabled` false = the durability writer is opted out
 *   (METRICS_SNAPSHOT_INTERVAL_SEC=0): the series is honestly empty and only
 *   the live verdict can be shown. `error` true = the series read FAILED at
 *   200 level: degrade to the live verdict, never render the empty-state
 *   copy a blank list would imply (session-105 honesty rule).
 * - items are OLDEST-FIRST (server contract) — the rail renders them in
 *   that order directly; the table re-sorts newest-first for scanning.
 * - Rule ids (`error_budget` etc.) are ops contract tokens and stay RAW —
 *   translating them would break grep-ability against the alert engine.
 *   The forensic `detail` strings ride from the stored report verbatim.
 * - Reads NEVER write server-side, so re-renders/polls cannot shift history.
 */

/** Table cap: alerting rows only, newest first (window default is 288 rows). */
const MAX_VISIBLE_ROWS = 15;

function windowLabel(sec: number, dash: string): string {
  if (sec >= 86400) return `${Math.round((sec / 86400) * 10) / 10}d`;
  if (sec >= 3600) return `${Math.round((sec / 3600) * 10) / 10}h`;
  if (sec >= 60) return `${Math.round(sec / 60)}m`;
  return sec > 0 ? `${sec}s` : dash;
}

function timeOf(iso: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, { timeStyle: 'medium' }).format(new Date(iso));
  } catch {
    return iso;
  }
}

/** Firing rules of one alerting row, collapsing to the stored report's fired
 *  detail strings (one line per rule id actually firing). */
function firingDetails(row: AlertVerdictRecord): string {
  const fired = row.report?.rules?.filter((rule) => rule.firing) ?? [];
  const lines = fired.map((rule) => `${rule.id}: ${rule.detail}`);
  return lines.length > 0 ? lines.join(' | ') : row.firingRules.join(', ');
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

export default function AlertsHistoryPanel({ history }: { history: AlertsHistory }) {
  const t = useTranslations('Portal');
  const dash = t('dash');

  const streak = history.streak;
  const alertingRows = history.items.filter((row) => row.status === 'alerting');
  const alertingPct =
    history.returned > 0 ? Math.round((alertingRows.length / history.returned) * 100) : null;
  const seriesUsable = history.enabled && !history.error;
  const newestFirst = [...alertingRows].reverse();
  const visible = newestFirst.slice(0, MAX_VISIBLE_ROWS);
  const hiddenRows = Math.max(0, newestFirst.length - visible.length);

  const streakValue = streak.alerting > 0 ? (streak.trailingCapped ? `≥${streak.alerting}` : String(streak.alerting)) : '0';

  return (
    <section className="mt-10" aria-labelledby="alerts-history-heading" data-testid="alerts-history-panel">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 id="alerts-history-heading" className="text-xl font-black text-stone-900">
          {t('alertsHistoryHeading')}
        </h2>
        <p className="text-xs text-stone-500" data-testid="alerts-history-meta">
          {t('alertsHistorySub', {
            window: windowLabel(history.window.windowSec, dash),
            interval: String(history.snapshotIntervalSec),
            time: timeOf(history.generatedAt),
          })}
        </p>
      </div>

      {history.error && (
        <div
          role="alert"
          className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800"
          data-testid="alerts-history-degraded"
        >
          {t('alertsDegraded')}
        </div>
      )}

      <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4" data-testid="alerts-history-cards">
        <Card
          label={t('alertsCardStreak')}
          value={streakValue}
          detail={
            streak.alerting === 0
              ? t('alertsStreakZero')
              : streak.trailingCapped
                ? t('alertsStreakCapped')
                : t('alertsStreakExact', { count: String(streak.alerting) })
          }
          testId="alerts-card-streak"
          tone={streak.alerting > 0 ? 'bad' : 'good'}
        />
        <Card
          label={t('alertsCardStatus')}
          value={streak.currentStatus === 'alerting' ? t('alertsStatusAlerting') : t('alertsStatusOk')}
          detail={t('alertsStatusDetail')}
          testId="alerts-card-status"
          tone={streak.currentStatus === 'alerting' ? 'bad' : 'good'}
        />
        <Card
          label={t('alertsCardSeries')}
          value={seriesUsable ? String(history.returned) : dash}
          detail={
            !history.enabled
              ? t('alertsWriterOff')
              : history.error
                ? t('alertsDegradedShort')
                : alertingPct === null
                  ? t('alertsSeriesEmpty')
                  : t('alertsSeriesDetail', {
                      count: String(history.returned),
                      pct: String(alertingPct),
                    })
          }
          testId="alerts-card-series"
        />
        <Card
          label={t('alertsCardLast')}
          value={history.lastCapturedAt ? timeOf(history.lastCapturedAt) : dash}
          detail={t('alertsLastDetail', {
            interval: String(history.snapshotIntervalSec),
          })}
          testId="alerts-card-last"
        />
      </div>

      {seriesUsable && history.items.length > 0 && (
        <div
          className="mt-6 flex flex-wrap gap-1 rounded-2xl border border-stone-200 bg-white p-4 shadow-sm"
          role="img"
          aria-label={t('alertsRailAria')}
          data-testid="alerts-rail"
        >
          {history.items.map((row, index) => (
            <span
              key={`${row.capturedAt}-${index}`}
              className={`h-4 w-4 rounded-sm ${row.status === 'alerting' ? 'bg-red-500' : 'bg-emerald-500'}`}
              title={`${timeOf(row.capturedAt)} · ${
                row.status === 'alerting' ? row.firingRules.join(', ') || t('alertsStatusAlerting') : t('alertsStatusOk')
              }`}
              data-testid="alerts-rail-cell"
              data-status={row.status}
            />
          ))}
        </div>
      )}

      {history.truncated && (
        <p className="mt-2 text-xs text-stone-500" data-testid="alerts-truncated-note">
          {t('alertsTruncatedNote')}
        </p>
      )}

      {seriesUsable && (
        <div className="mt-6 overflow-x-auto rounded-2xl border border-stone-200 bg-white shadow-sm" data-testid="alerts-firing-table">
          <table className="min-w-full text-left text-sm">
            <caption className="sr-only">{t('alertsFiringCaption')}</caption>
            <thead className="bg-stone-50 text-xs uppercase tracking-wide text-stone-500">
              <tr>
                <th scope="col" className="px-4 py-3">{t('alertsThTime')}</th>
                <th scope="col" className="px-4 py-3">{t('alertsThRules')}</th>
                <th scope="col" className="px-4 py-3">{t('alertsThDetail')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {visible.length === 0 && (
                <tr>
                  <td colSpan={3} className="px-4 py-6 text-center text-stone-500" data-testid="alerts-firing-empty">
                    {history.returned === 0 ? t('alertsSeriesNoRows') : t('alertsSeriesAllOk')}
                  </td>
                </tr>
              )}
              {visible.map((row, index) => (
                <tr key={`${row.capturedAt}-${index}`}>
                  <td className="whitespace-nowrap px-4 py-3 font-mono text-xs font-bold text-stone-900">
                    {timeOf(row.capturedAt)}
                  </td>
                  <td className="px-4 py-3">
                    <span className="flex flex-wrap gap-1">
                      {row.firingRules.map((ruleId) => (
                        <span
                          key={ruleId}
                          className="rounded-full bg-red-50 px-2 py-0.5 font-mono text-xs font-bold text-red-700"
                        >
                          {ruleId}
                        </span>
                      ))}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-stone-600">{firingDetails(row)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {seriesUsable && hiddenRows > 0 && (
        <p className="mt-2 text-xs text-stone-500" data-testid="alerts-hidden-note">
          {t('alertsHiddenNote', { cap: String(MAX_VISIBLE_ROWS), total: String(newestFirst.length) })}
        </p>
      )}
    </section>
  );
}
