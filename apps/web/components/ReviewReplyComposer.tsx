'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { ReviewRow } from '@/lib/api';

/** The API's own ReplyReviewDto cap (MAX_LENGTH 2000) mirrored in the UI. */
const REPLY_MAX_LENGTH = 2000;

export type ReplyBusy = 'idle' | 'saving' | 'clearing';

/**
 * Owner reply thread for ONE review (Phase 9, session 102). Wraps the
 * session-101 pair `PATCH /reviews/:id/reply` + `DELETE /reviews/:id/reply`.
 *
 * Contract notes this component must keep honest:
 *  - ONE thread per review — saving again REPLACES the text (no history UI).
 *  - The thread lives ON the review row, so a failed save changes nothing
 *    publicly: the card keeps showing the previous thread and keeps the
 *    draft (an owner's text is never silently discarded).
 *  - DELETE is idempotent server-side; we still only offer it when a reply
 *    actually exists, so the button never promises a no-op.
 *  - A reply NEVER moves stars. There is no rating anywhere in this card on
 *    purpose — the API reply response carries no aggregate either.
 *
 * The parent owns persistence: `onSave(text)` / `onDelete()` resolve to
 * `null` on success or an error message string; the fresh row reaches this
 * component through the `review` prop when the parent updates its list.
 */
export default function ReviewReplyComposer({
  review,
  busy,
  onSave,
  onDelete,
}: {
  review: ReviewRow;
  busy: ReplyBusy;
  onSave: (text: string) => Promise<string | null>;
  onDelete: () => Promise<string | null>;
}) {
  const t = useTranslations('Portal');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(review.reply ?? '');
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // While the owner is NOT mid-edit, the draft mirrors the server row (a
  // save round-trip, a list refresh). An in-flight draft is never stomped.
  useEffect(() => {
    if (!editing) setDraft(review.reply ?? '');
  }, [review.reply, editing]);

  useEffect(() => {
    if (editing) textareaRef.current?.focus();
  }, [editing]);

  const trimmed = draft.trim();
  const unchanged = trimmed === (review.reply ?? '').trim();

  const submit = async () => {
    if (!trimmed || unchanged || busy !== 'idle') return;
    const err = await onSave(trimmed);
    if (err === null) {
      setEditing(false);
      setFeedback({ kind: 'ok', text: t('rvSavedNote') });
    } else {
      setFeedback({ kind: 'err', text: err });
    }
  };

  const clearThread = async () => {
    if (busy !== 'idle') return;
    const err = await onDelete();
    if (err === null) {
      setEditing(false);
      setFeedback({ kind: 'ok', text: t('rvClearedNote') });
    } else {
      setFeedback({ kind: 'err', text: err });
    }
  };

  return (
    <div className="mt-3" data-testid="reply-composer">
      {review.reply && !editing && (
        <div
          className="rounded-lg border border-stone-200 bg-stone-50 p-3"
          data-testid="existing-reply"
        >
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-xs font-bold text-stone-700">{t('rvThreadLabel')}</span>
            {review.repliedAt && (
              <time className="text-[11px] text-stone-400" dateTime={review.repliedAt}>
                {review.repliedAt.slice(0, 10)}
              </time>
            )}
          </div>
          <p className="mt-1 text-sm text-stone-600">{review.reply}</p>
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        {!editing && (
          <button
            type="button"
            onClick={() => {
              setFeedback(null);
              setEditing(true);
            }}
            className="rounded-xl border border-stone-300 bg-white px-3 py-1.5 text-xs font-semibold text-stone-700 hover:bg-stone-100"
          >
            {review.reply ? t('rvEditThread') : t('rvReply')}
          </button>
        )}
        {editing && (
          <button
            type="button"
            onClick={() => {
              setEditing(false);
              setDraft(review.reply ?? '');
              setFeedback(null);
            }}
            className="rounded-xl border border-stone-300 bg-white px-3 py-1.5 text-xs font-semibold text-stone-700 hover:bg-stone-100"
          >
            {t('rvCancel')}
          </button>
        )}
        {review.reply && (
          <button
            type="button"
            onClick={() => void clearThread()}
            disabled={busy !== 'idle'}
            className="rounded-xl border border-rose-200 bg-white px-3 py-1.5 text-xs font-semibold text-rose-700 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy === 'clearing' ? t('rvDeleting') : t('rvClearThread')}
          </button>
        )}
      </div>

      {feedback && (
        <p
          role={feedback.kind === 'err' ? 'alert' : 'status'}
          className={`mt-2 text-xs font-semibold ${
            feedback.kind === 'err' ? 'text-rose-700' : 'text-emerald-700'
          }`}
          data-testid="reply-feedback"
        >
          {feedback.text}
        </p>
      )}

      {editing && (
        <div className="mt-2">
          <label htmlFor={`reply-${review.id}`} className="block text-xs font-bold text-stone-700">
            {t('rvComposerLabel', { reviewer: review.reviewerName, code: review.orderCode })}
          </label>
          <textarea
            id={`reply-${review.id}`}
            ref={textareaRef}
            rows={3}
            maxLength={REPLY_MAX_LENGTH}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            aria-describedby={`reply-hint-${review.id}`}
            className="mt-1 w-full rounded-xl border border-stone-300 bg-white px-3 py-2 text-base outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-200"
          />
          <p id={`reply-hint-${review.id}`} className="mt-1 text-[11px] text-stone-400">
            {t('rvComposerHint', { max: String(REPLY_MAX_LENGTH) })}
          </p>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!trimmed || unchanged || busy !== 'idle'}
            className="mt-2 rounded-xl bg-brand-600 px-4 py-2 text-xs font-semibold text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy === 'saving'
              ? t('rvSaving')
              : review.reply
                ? t('rvSaveEdit')
                : t('rvSaveReply')}
          </button>
        </div>
      )}
    </div>
  );
}
