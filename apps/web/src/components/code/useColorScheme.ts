import { useSyncExternalStore } from 'react';

const QUERY = '(prefers-color-scheme: dark)';

function subscribe(onChange: () => void) {
  if (typeof window.matchMedia !== 'function') return () => {};
  const media = window.matchMedia(QUERY);
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}

function isDark() {
  return typeof window.matchMedia === 'function' && window.matchMedia(QUERY).matches;
}

/** The Monaco theme matching the system's light or dark colour scheme, kept up to date. */
export function useMonacoTheme(): 'vs' | 'vs-dark' {
  return useSyncExternalStore(subscribe, isDark, () => false) ? 'vs-dark' : 'vs';
}
