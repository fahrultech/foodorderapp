/** Full classes are written literally per status so Tailwind's scanner keeps them. */
const BADGE_CLASS: Record<string, string> = {
  pending: 'bg-amber-100 text-amber-800',
  confirmed: 'bg-sky-100 text-sky-800',
  preparing: 'bg-violet-100 text-violet-800',
  delivering: 'bg-orange-100 text-orange-800',
  completed: 'bg-emerald-100 text-emerald-800',
  cancelled: 'bg-rose-100 text-rose-700',
};

const LABEL: Record<string, string> = {
  pending: 'Pending',
  confirmed: 'Confirmed',
  preparing: 'Preparing',
  delivering: 'Delivering',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

export default function StatusBadge({ status }: { status: string }) {
  const cls = BADGE_CLASS[status] ?? 'bg-stone-100 text-stone-700';
  const label = LABEL[status] ?? status;
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold ${cls}`}
    >
      {label}
    </span>
  );
}
