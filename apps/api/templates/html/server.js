// A tiny web server that shows the files in this folder. No packages needed.
// Start it with: npm start
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.PORT) || 8080;
// DevSpace's Preview shows your app under a longer address. This makes both work.
const BASE = process.env.DEVSPACE_PREVIEW_BASE_8080 || '/';
const FOLDER = __dirname;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
}

const server = http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    notFound(res);
    return;
  }
  if (BASE !== '/' && urlPath.startsWith(BASE)) {
    urlPath = '/' + urlPath.slice(BASE.length);
  }
  if (urlPath.endsWith('/')) urlPath += 'index.html';

  const file = path.join(FOLDER, path.normalize(urlPath));
  // Only files inside this folder, never anything else on the computer.
  if (!file.startsWith(FOLDER + path.sep)) {
    notFound(res);
    return;
  }

  fs.readFile(file, (err, data) => {
    if (err) {
      notFound(res);
      return;
    }
    const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Your website is running on port ${PORT}. Click Preview in DevSpace to see it.`);
});
