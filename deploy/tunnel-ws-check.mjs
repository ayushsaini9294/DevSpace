// WebSocket checks for the local proof of tunnel mode (deploy/tunnel-smoke.sh), through the
// stand-in for Cloudflare (deploy/tunnel-standin.mjs). Not used when DevSpace is live.
//
//   1. The app's live updates: a Socket.io WebSocket on https://<APP_DOMAIN>/socket.io/, with the
//      app's Origin and a session cookie, is upgraded (101) and Socket.io accepts the connection.
//   2. An IDE host's WebSockets: refused with 403 from another origin, and 404 from the copy's own
//      origin without an IDE cookie. (A 404 for both would mean the API didn't see https or the
//      copy's host through the tunnel.)
//
// Environment: APP_DOMAIN, IDE_DOMAIN, SESSION ("devspace_session=…"), STANDIN_PORT (443).
// Prints one line per check; exits 1 on the first failure.

import { randomBytes } from 'node:crypto';
import tls from 'node:tls';

const port = Number(process.env.STANDIN_PORT || 443);
const app = process.env.APP_DOMAIN;
const ide = process.env.IDE_DOMAIN;
const session = process.env.SESSION;
const copy = '00000000-0000-4000-8000-000000000000';

function fail(message) {
  console.error(`FAILED - ${message}`);
  process.exit(1);
}

/** Opens a WebSocket by hand; resolves with { status, socket, rest } once the response head is in. */
function upgrade(host, path, headers) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host: '127.0.0.1',
      port,
      servername: host,
      rejectUnauthorized: false,
    });
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => reject(new Error(`no answer from ${host}${path}`)), 10_000);
    socket.on('error', reject);
    socket.once('secureConnect', () => {
      const lines = [
        `GET ${path} HTTP/1.1`,
        `Host: ${host}`,
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Version: 13',
        `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`,
        ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
      ];
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
    });
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      socket.off('data', onData);
      clearTimeout(timer);
      const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(buf.subarray(0, end).toString())?.[1] ?? 0);
      resolve({ status, socket, rest: buf.subarray(end + 4) });
    };
    socket.on('data', onData);
  });
}

/** Reads text frames (server frames are unmasked) and calls `onText` for each. */
function readFrames(socket, first, onText) {
  let buf = first;
  const parse = () => {
    for (;;) {
      if (buf.length < 2) return;
      let len = buf[1] & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        offset = 10;
      }
      if (buf.length < offset + len) return;
      const opcode = buf[0] & 0x0f;
      const payload = buf.subarray(offset, offset + len);
      buf = buf.subarray(offset + len);
      if (opcode === 1) onText(payload.toString('utf8'));
    }
  };
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    parse();
  });
  parse();
}

/** One masked text frame (clients must mask). */
function textFrame(text) {
  const payload = Buffer.from(text);
  const mask = randomBytes(4);
  const masked = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]));
  return Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, masked]);
}

// 1. The app's Socket.io WebSocket.
{
  const { status, socket, rest } = await upgrade(app, '/socket.io/?EIO=4&transport=websocket', {
    Origin: `https://${app}`,
    Cookie: session,
  });
  if (status !== 101) fail(`the app's WebSocket answered ${status}, not 101`);
  const result = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), 10_000);
    readFrames(socket, rest, (text) => {
      if (text.startsWith('0{'))
        socket.write(textFrame('40')); // Engine.IO open → join "/"
      else if (text === '2')
        socket.write(textFrame('3')); // ping → pong
      else if (text.startsWith('40{')) {
        clearTimeout(timer);
        resolve('connected');
      } else if (text.startsWith('44')) {
        clearTimeout(timer);
        resolve(`refused: ${text}`);
      }
    });
  });
  socket.destroy();
  if (result !== 'connected') fail(`Socket.io over the tunnel: ${result}`);
  console.log(`ok - the app's live updates (Socket.io WebSocket) connect through the tunnel`);
}

// 2. An IDE host's WebSockets.
{
  const host = `${copy}.${ide}`;
  const other = await upgrade(host, `/ide/${copy}/`, { Origin: `https://evil.${ide}` });
  other.socket.destroy();
  if (other.status !== 403)
    fail(`an IDE WebSocket from another origin answered ${other.status}, not 403`);
  const own = await upgrade(host, `/ide/${copy}/`, { Origin: `https://${host}` });
  own.socket.destroy();
  if (own.status !== 404) fail(`an IDE WebSocket without a cookie answered ${own.status}, not 404`);
  console.log(
    'ok - IDE WebSockets reach the API as https on the copy host: 403 from another origin, 404 without an IDE cookie',
  );
}
