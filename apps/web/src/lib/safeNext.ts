const AUTH_PAGES = new Set(['/login', '/signup']);

/**
 * Turn a `next` query parameter into a safe in-app path to go to after logging in.
 * Accepts only same-site relative paths that start with a single "/" (so no "//evil.com",
 * "/\evil.com", "https://…" or "javascript:"); anything else, or a path back to the
 * login/signup pages, falls back to "/".
 */
export function safeNext(raw: string | null | undefined): string {
  const fallback = '/';
  if (!raw || !raw.startsWith('/') || raw.startsWith('//')) return fallback;
  // Browsers treat "\" like "/" in URLs, and control characters are never legitimate here.
  for (const char of raw) {
    const code = char.charCodeAt(0);
    if (char === '\\' || code < 0x20 || code === 0x7f) return fallback;
  }

  const base = 'https://devspace.invalid';
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    return fallback;
  }
  if (url.origin !== base) return fallback;
  if (AUTH_PAGES.has(url.pathname.replace(/\/+$/, '') || '/')) return fallback;
  return `${url.pathname}${url.search}${url.hash}`;
}
