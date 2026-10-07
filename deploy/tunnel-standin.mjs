// A stand-in for Cloudflare + cloudflared, for the local proof of tunnel mode
// (deploy/tunnel-smoke.sh). It is NOT used when DevSpace is live.
//
// Like Cloudflare's edge, it answers the browser over HTTPS (here with a throwaway self-signed
// certificate), then, like cloudflared, passes each request to Caddy over plain http on this
// machine with:
//   - the Host the browser asked for, unchanged;
//   - X-Forwarded-Proto: https and CF-Visitor: {"scheme":"https"};
//   - CF-Connecting-IP: the visitor's address (any CF-Connecting-IP the visitor sent is replaced);
//   - X-Forwarded-For: whatever the visitor sent, with the visitor's address added at the end.
// WebSockets are passed through the same way. Since every request here comes from this machine,
// the "visitor's address" is taken from a test-only header, X-Standin-Client-Ip (removed before
// passing the request on), or 203.0.113.7 by default.
//
// Settings (environment): STANDIN_PORT (443), STANDIN_CERT, STANDIN_KEY (PEM files),
// TUNNEL_HTTP_PORT (Caddy's port, 8080).

import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

const listenPort = Number(process.env.STANDIN_PORT || 443);
const caddyPort = Number(process.env.TUNNEL_HTTP_PORT || 8080);
const DEFAULT_CLIENT = '203.0.113.7';

/** Hop-by-hop headers a proxy never passes on (except Upgrade/Connection for WebSockets). */
const HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
/** Headers Cloudflare sets itself, whatever the visitor sent. */
const OWN = new Set([
  'cf-connecting-ip',
  'cf-visitor',
  'cf-ray',
  'x-forwarded-proto',
  'x-standin-client-ip',
]);

function edgeHeaders(req, upgrade) {
  const raw = req.headers['x-standin-client-ip'];
  const client = net.isIP(String(raw ?? '')) ? String(raw) : DEFAULT_CLIENT;
  const out = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || OWN.has(name)) continue;
    if (HOP.has(name) && !(upgrade && (name === 'upgrade' || name === 'connection'))) continue;
    out[name] = value;
  }
  const xff = req.headers['x-forwarded-for'];
  out['x-forwarded-for'] = xff ? `${xff}, ${client}` : client;
  out['x-forwarded-proto'] = 'https';
  out['cf-connecting-ip'] = client;
  out['cf-visitor'] = '{"scheme":"https"}';
  out['cf-ray'] = `${Math.random().toString(16).slice(2, 18)}-LOCAL`;
  return out;
}

const server = https.createServer({
  cert: readFileSync(process.env.STANDIN_CERT),
  key: readFileSync(process.env.STANDIN_KEY),
});

server.on('request', (req, res) => {
  const upstream = http.request(
    {
      host: '127.0.0.1',
      port: caddyPort,
      method: req.method,
      path: req.url,
      headers: edgeHeaders(req, false),
    },
    (up) => {
      const headers = { ...up.headers };
      for (const name of HOP) delete headers[name];
      res.writeHead(up.statusCode ?? 502, headers);
      up.pipe(res);
    },
  );
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
    res.end('stand-in: Caddy did not answer\n');
  });
  req.pipe(upstream);
});

server.on('upgrade', (req, socket, head) => {
  const up = net.connect(caddyPort, '127.0.0.1');
  socket.on('error', () => up.destroy());
  up.on('error', () => socket.destroy());
  up.once('connect', () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (const [name, value] of Object.entries(edgeHeaders(req, true))) {
      for (const v of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${v}`);
    }
    up.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head.length > 0) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
});

server.listen(listenPort, '127.0.0.1', () => {
  console.log(`stand-in: https://127.0.0.1:${listenPort} -> http://127.0.0.1:${caddyPort}`);
});
