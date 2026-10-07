import type { IncomingMessage } from 'node:http';
import express from 'express';
import { env } from '../config/env.ts';

/**
 * One address per copy (Phase 14): each copy's IDE runs on its own origin,
 * `<scheme>://<copyId>.<base host>[:port]`, built from IDE_BASE_URL. Browsers then keep copies
 * fully apart (cookies, storage, CORS), so a page in one copy can't use another copy's IDE.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const base = new URL(env.IDE_BASE_URL);
/** `:<port>` when IDE_BASE_URL names a non-default port, else ''. */
const portSuffix = base.port ? `:${base.port}` : '';
/** What follows `<copyId>.` in a copy's Host header, e.g. `ide.localhost:3100`. */
const hostSuffix = `.${base.hostname}${portSuffix}`;

/** The origin of one copy's IDE, e.g. `http://<copyId>.ide.localhost:3100`. */
export function ideOriginFor(copyId: string): string {
  return `${base.protocol}//${copyId}${hostSuffix}`;
}

/** The Host header a browser sends for one copy's IDE, e.g. `<copyId>.ide.localhost:3100`. */
export function ideHostFor(copyId: string): string {
  return `${copyId}${hostSuffix}`;
}

/**
 * The copy a request's Host names, or null. The first label must be a copy id (a lowercase
 * UUID) and the rest must be exactly the base host (and port). The bare base host, other hosts,
 * and anything with extra labels get null.
 */
export function copyIdFromHost(host: string | undefined): string | null {
  if (!host) return null;
  const value = host.toLowerCase();
  if (!value.endsWith(hostSuffix)) return null;
  const copyId = value.slice(0, -hostSuffix.length);
  return UUID.test(copyId) ? copyId : null;
}

/** Express's own `trust proxy` check, compiled from TRUST_PROXY. */
const trust = express().set('trust proxy', env.TRUST_PROXY).get('trust proxy fn') as (
  addr: string,
  index: number,
) => boolean;

/**
 * The scheme the browser used, as told by a trusted proxy (`X-Forwarded-Proto`), or null when
 * the request didn't come through one (TRUST_PROXY unset, or the peer isn't trusted).
 */
export function forwardedProto(req: IncomingMessage): string | null {
  const peer = req.socket.remoteAddress;
  if (!peer || !trust(peer, 0)) return null;
  const header = req.headers['x-forwarded-proto'];
  const first = String(Array.isArray(header) ? header[0] : (header ?? ''))
    .split(',', 1)[0]!
    .trim()
    .toLowerCase();
  return first || null;
}

/** IDE_BASE_URL's scheme without the colon (`http` or `https`). */
export const IDE_SCHEME = base.protocol.slice(0, -1);
