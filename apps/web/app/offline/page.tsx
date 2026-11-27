import OfflineCard from '@/components/OfflineCard';
import OfflineRestoreIsland from '@/components/OfflineRestoreIsland';

/**
 * The offline app shell (Phase 16 #3). When the service worker cannot reach
 * the web server at all, it serves this page for failed navigations — today
 * as a generic card (pre-cached), and for /orders/<id> URLs whose receipt the
 * device actually holds (lib/order-cache), the island restores the saved
 * copy behind the same honest banner the API-down branch shows (session 137).
 * The fallback card is passed in, so a non-receipt URL — or an order the
 * browser never viewed — renders exactly what this route always did.
 */
export default function OfflinePage() {
  return <OfflineRestoreIsland fallback={<OfflineCard />} />;
}
