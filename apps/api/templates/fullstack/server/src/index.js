// The server (back end). The React app (client) asks it for data under /api.
const express = require('express');

// 8081, so it doesn't clash with other apps. Port 3000 is used by the IDE.
const PORT = Number(process.env.PORT) || 8081;

const app = express();
app.use(express.json());

app.get('/api/hello', (req, res) => {
  res.json({ message: 'Hello from the server!' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`The server is running on port ${PORT}.`);
});
