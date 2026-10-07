/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** A file of the web app, read as text (Vite's `?raw` returns nothing for CSS under Vitest). */
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

const page = new DOMParser().parseFromString(read('../../index.html'), 'text/html');
const css = read('../index.css');

/** A `--ds-…` token's value in the light (first) or dark (second) block of index.css. */
function token(name: string, scheme: 'light' | 'dark'): string | undefined {
  const values = [...css.matchAll(new RegExp(`--ds-${name}:\\s*(#[0-9a-f]{6})`, 'gi'))].map(
    (match) => match[1]?.toLowerCase(),
  );
  return values[scheme === 'light' ? 0 : 1];
}

describe('page head', () => {
  it('links the DevSpace mark as an SVG favicon', () => {
    const icon = page.querySelector('link[rel="icon"]');
    expect(icon?.getAttribute('href')).toBe('/favicon.svg');
    expect(icon?.getAttribute('type')).toBe('image/svg+xml');
  });

  it('draws the favicon like the LogoMark, in the accent colour', () => {
    const svg = new DOMParser().parseFromString(
      read('../../public/favicon.svg'),
      'image/svg+xml',
    ).documentElement;
    expect(svg.getAttribute('viewBox')).toBe('0 0 32 32');
    expect(token('accent', 'light')).toBe('#4f46e5');
    expect(svg.querySelector('rect')?.getAttribute('fill')).toBe(token('accent', 'light'));
    expect(svg.querySelector('path')?.getAttribute('d')).toBe(
      'M11 10.5 6.5 16l4.5 5.5M21 10.5l4.5 5.5-4.5 5.5M18 9l-4 14',
    );
  });

  it('has a theme colour for light and dark mode that matches the top bar', () => {
    const colours = Object.fromEntries(
      [...page.querySelectorAll('meta[name="theme-color"]')].map((meta) => [
        meta.getAttribute('media'),
        meta.getAttribute('content'),
      ]),
    );
    expect(colours).toEqual({
      '(prefers-color-scheme: light)': token('surface', 'light'),
      '(prefers-color-scheme: dark)': token('surface', 'dark'),
    });
    expect(colours['(prefers-color-scheme: dark)']).toBeDefined();
  });

  it('has no inline scripts (the production CSP allows only the app’s own files)', () => {
    const scripts = [...page.querySelectorAll('script')];
    expect(scripts.length).toBeGreaterThan(0);
    for (const script of scripts) {
      expect(script.getAttribute('src')).toBeTruthy();
      expect(script.textContent.trim()).toBe('');
    }
  });
});
