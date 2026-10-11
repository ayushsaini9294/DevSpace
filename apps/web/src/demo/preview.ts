/**
 * The demo IDE's preview: one page of the visitor's copy as a single HTML document, with the
 * copy's stylesheets, scripts and images it links to put inside it. It's shown in a sandboxed
 * frame (`public/demo/preview.html`), never with the app's origin.
 */

/** Messages between the app and the preview frame. */
export const PREVIEW_READY = 'devspace-demo-preview-ready';
export const PREVIEW_SHOW = 'devspace-demo-preview-show';
export const PREVIEW_OPEN = 'devspace-demo-preview-open';

/** The preview frame's page, in this site's folder (the demo may live in a subfolder). */
export const PREVIEW_FRAME_URL = `${import.meta.env.BASE_URL}demo/preview.html`;

/**
 * A path in the copy for a link written in `fromPage`, or null for links that leave the copy
 * (other sites, `mailto:`, `data:`) or point at the page itself (`#top`).
 */
export function resolveCopyPath(fromPage: string, href: string): string | null {
  const link = href.trim().split('#')[0]!.split('?')[0]!;
  if (link === '' || /^[a-z][a-z0-9+.-]*:/i.test(link) || link.startsWith('//')) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(link);
  } catch {
    return null;
  }
  const parts = decoded.startsWith('/') ? [] : fromPage.split('/').slice(0, -1);
  for (const part of decoded.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts.length > 0 ? parts.join('/') : null;
}

function attribute(tag: string, name: string): string | null {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return match ? (match[1] ?? match[2] ?? match[3] ?? '') : null;
}

function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/**
 * Runs first in the preview: links to other pages of the copy ask the app to show that page
 * (the frame can't load them by itself), and links that would leave the preview do nothing.
 */
const LINK_HELPER = `<script>
document.addEventListener('click', function (event) {
  var link = event.target instanceof Element ? event.target.closest('a[href]') : null;
  if (!link) return;
  var href = link.getAttribute('href') || '';
  if (href.charAt(0) === '#') return;
  event.preventDefault();
  parent.postMessage({ type: '${PREVIEW_OPEN}', href: href }, '*');
});
</script>`;

/** The browser's usual white page, unless the visitor's own styles say otherwise. */
const PAGE_DEFAULTS = '<style>html { background: #fff; color: #000; color-scheme: light; }</style>';

/** One page of the copy as a single document for the preview frame. */
export function buildPreviewHtml(files: Record<string, string>, page: string): string {
  const html = files[page];
  if (html === undefined) {
    return `${PAGE_DEFAULTS}<p style="font-family: sans-serif">There is no ${page.replace(/[<>&]/g, '')} in your copy.</p>`;
  }
  const fileFor = (href: string | null) => {
    const path = href === null ? null : resolveCopyPath(page, href);
    return path === null ? undefined : files[path];
  };

  let out = html
    // <link rel="stylesheet" href="style.css"> → the stylesheet itself.
    .replace(/<link\b[^>]*>/gi, (tag) => {
      if (!/^stylesheet$/i.test(attribute(tag, 'rel') ?? '')) return tag;
      const css = fileFor(attribute(tag, 'href'));
      return css === undefined ? tag : `<style>\n${css.replace(/<\/style/gi, '<\\/style')}</style>`;
    })
    // <script src="script.js"></script> → the script itself.
    .replace(/<script\b([^>]*)>\s*<\/script\s*>/gi, (tag, attrs: string) => {
      const js = fileFor(attribute(tag, 'src'));
      if (js === undefined) return tag;
      const rest = attrs.replace(/\ssrc\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i, '');
      return `<script${rest}>\n${js.replace(/<\/script/gi, '<\\/script')}</script>`;
    })
    // <img src="images/photo.svg"> → the picture, when it's an SVG in the copy.
    .replace(/<img\b[^>]*>/gi, (tag) => {
      const src = attribute(tag, 'src');
      const svg = src !== null && /\.svg$/i.test(src.split(/[?#]/)[0]!) ? fileFor(src) : undefined;
      if (svg === undefined) return tag;
      return tag.replace(/\ssrc\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i, ` src="${svgDataUrl(svg)}"`);
    });

  const helpers = PAGE_DEFAULTS + LINK_HELPER;
  const head = /<head\b[^>]*>/i.exec(out);
  if (head) {
    const at = head.index + head[0].length;
    out = out.slice(0, at) + helpers + out.slice(at);
  } else {
    out = helpers + out;
  }
  return out;
}
