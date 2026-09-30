// A small web server made with Express.
// Start it with: npm install (once), then npm start
const path = require('node:path');
const express = require('express');

const PORT = Number(process.env.PORT) || 8080;
// DevSpace's Preview shows your app under a longer address. This makes both work.
const BASE = process.env.DEVSPACE_PREVIEW_BASE_8080 || '/';

const app = express();
const routes = express.Router();

// The files in the "public" folder (your web page).
routes.use(express.static(path.join(__dirname, '..', 'public')));

// A small API: open api/hello to see it.
routes.get('/api/hello', (req, res) => {
  res.json({ message: 'Hello from Express!' });
});

app.use(BASE, routes);
if (BASE !== '/') app.use('/', routes);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Your app is running on port ${PORT}. Click Preview in DevSpace to see it.`);
});
