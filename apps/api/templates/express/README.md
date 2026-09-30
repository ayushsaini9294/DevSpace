# My Express app

A small web server made with Node.js and Express.

- `src/index.js`: the server. It shows the page and answers `api/hello`.
- `public/index.html`: the web page. It asks the server for a message.
- `package.json`: the list of packages this app needs.

## How to run it

1. Click **Open IDE** on the project page.
2. Open a terminal: menu **Terminal → New Terminal**.
3. Start the server:

   ```
   npm start
   ```

   The first time, it installs the packages it needs before starting, which takes about a
   minute. After that it starts in a few seconds.

   You will see "Your app is running on port 8080".

## How to see it

Click **Preview** in DevSpace (port **8080**). Your page opens in a new tab.
After you change `public/index.html`, reload that tab. After you change `src/index.js`,
stop the server (click in the terminal, press Ctrl+C) and run `npm start` again.

Tip: in your page, write links without a `/` at the start (`api/hello`, not `/api/hello`),
so they work in Preview.

## How to send your work

Your files live in **your copy** (your own space to work in). When you are happy with a change:

1. Click **Submit work** (send your changes for review).
2. Tick the files you changed, write a short title, and send it.
3. A teammate reviews it. When a leader merges it, it is added to **main** (the team's shared version).
