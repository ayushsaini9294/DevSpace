# My full-stack app

A web app in two parts:

- `client/`: the front end (what you see), made with React and Vite. Start with `client/src/App.jsx`.
- `server/`: the back end (the data), made with Express. See `server/src/index.js`.

The page asks the server for a message at `api/hello`. Vite passes those requests on to the server.

## How to run it

1. Click **Open IDE** on the project page.
2. Open a terminal: menu **Terminal → New Terminal**.
3. Install the packages for both parts (only the first time, or when a `package.json` changes):

   ```
   npm install
   ```

4. Start both parts together:

   ```
   npm run dev
   ```

   The server runs on port 8081 and the app on port 5173.

## How to see it

Click **Preview** in DevSpace (port **5173**). Your app opens in a new tab and shows the server's message.
The page updates by itself when you save a file in `client/`, and the server restarts by itself
when you save a file in `server/`.

To stop both, click in the terminal and press Ctrl+C.

Tip: in the page, call the server with links that don't start with `/` (`api/hello`, not `/api/hello`),
so they work in Preview.

## How to send your work

Your files live in **your copy** (your own space to work in). When you are happy with a change:

1. Click **Submit work** (send your changes for review).
2. Tick the files you changed, write a short title, and send it.
3. A teammate reviews it. When a leader merges it, it is added to **main** (the team's shared version).
