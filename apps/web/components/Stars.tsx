/**
 * Display-only star row (server-safe: no hooks, no interactivity — the same
 * markup must render identically in RSC restaurant pages and client review
 * cards). `aria-label` carries the value for screen readers; the glyphs are
 * decorative.
 */
export default function Stars({ rating, className = '' }: { rating: number; className?: string }) {
  const full = Math.max(0, Math.min(5, Math.round(rating)));
  return (
    <span className={className} role="img" aria-label={`${full} out of 5 stars`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <span key={i} aria-hidden="true" className={i <= full ? 'text-amber-500' : 'text-stone-300'}>
          {i <= full ? '★' : '☆'}
        </span>
      ))}
    </span>
  );
}
