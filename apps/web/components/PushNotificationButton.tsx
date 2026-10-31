'use client';

import { usePushNotifications } from '@/lib/push-notifications';

export default function PushNotificationButton() {
  const { state, error, enable, disable } = usePushNotifications();

  if (state === 'loading') {
    return <span className="h-9 w-9 rounded-full bg-stone-100" aria-hidden />;
  }

  const isOn = state === 'on';
  const busy = state === 'working';
  const disabled = busy || state === 'unsupported' || state === 'unavailable' || state === 'blocked';
  const label = isOn ? 'Disable notifications' : 'Enable notifications';
  const title =
    state === 'unsupported'
      ? 'Browser notifications are not supported here'
      : state === 'unavailable'
        ? 'Notifications are not configured on this server'
        : state === 'blocked'
          ? 'Notifications are blocked in your browser settings'
          : error || label;

  return (
    <button
      type="button"
      aria-label={label}
      title={title}
      aria-pressed={isOn}
      disabled={disabled}
      onClick={() => void (isOn ? disable() : enable())}
      className={`flex h-9 w-9 items-center justify-center rounded-full text-base transition ${
        isOn
          ? 'bg-brand-100 text-brand-700 hover:bg-brand-200'
          : 'text-stone-600 hover:bg-stone-100'
      } disabled:cursor-not-allowed disabled:opacity-45`}
    >
      <span aria-hidden>{busy ? '…' : isOn ? '🔔' : '🔕'}</span>
    </button>
  );
}
