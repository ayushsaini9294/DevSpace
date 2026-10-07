import type { Server } from 'node:http';
import request from 'supertest';
import { ideHostFor } from '../src/ide/origin.ts';

/**
 * Requests to the IDE listener with the Host a browser would send (Phase 14: every copy has
 * its own address). A target may be a full launch URL (its own host is used) or a path; for a
 * path the host is `copyId`'s, or the copy named in `/ide/<copyId>/…`.
 */
export function ideHostOf(path: string, copyId?: string): string {
  if (copyId) return ideHostFor(copyId);
  const match = /^\/ide\/([0-9a-f-]{36})(?:[/?]|$)/.exec(path);
  if (!match) throw new Error(`no copy in ${path}: pass its copy id`);
  return ideHostFor(match[1]!);
}

function target(urlOrPath: string, copyId?: string): { path: string; host: string } {
  if (/^https?:\/\//.test(urlOrPath)) {
    const url = new URL(urlOrPath);
    return { path: `${url.pathname}${url.search}`, host: url.host };
  }
  return { path: urlOrPath, host: ideHostOf(urlOrPath, copyId) };
}

export function ideRequest(server: Server, copyId?: string) {
  return {
    get(urlOrPath: string) {
      const { path, host } = target(urlOrPath, copyId);
      return request(server).get(path).set('Host', host);
    },
    post(urlOrPath: string) {
      const { path, host } = target(urlOrPath, copyId);
      return request(server).post(path).set('Host', host);
    },
  };
}
