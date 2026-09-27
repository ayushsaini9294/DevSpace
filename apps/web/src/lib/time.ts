export const fullDate = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});
const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

/** "5 minutes ago", "yesterday"; the full date after a week. */
export function formatWhen(iso: string, now: number = Date.now()): string {
  const date = new Date(iso);
  const seconds = Math.round((date.getTime() - now) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 60) return 'just now';
  if (abs < 3600) return relative.format(Math.round(seconds / 60), 'minute');
  if (abs < 86400) return relative.format(Math.round(seconds / 3600), 'hour');
  if (abs < 7 * 86400) return relative.format(Math.round(seconds / 86400), 'day');
  return fullDate.format(date);
}
