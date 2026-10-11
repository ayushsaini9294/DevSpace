/**
 * The sample project's files ("Class Website", a small class web page built by a school coding
 * club). Every version a sample submission needs is built here from shared pieces, so the diffs
 * in the demo are real diffs between these texts.
 */

const README = `# Class Website

The website of Class 9B, built by our coding club.

## How to run it

1. Open the project in the IDE.
2. In the terminal, run \`npm start\`.
3. Click **Preview** and pick port 8080.

## Who does what

- Demo Leader: project leader
- Maya Chen: menus and layout
- Leo Martins: photo gallery
- Sara Okafor: contact page and dark mode
`;

const README_WITH_ABOUT = README.replace(
  '## Who does what',
  `## Pages

- \`index.html\`: the home page with this week's timetable
- \`about.html\`: who we are

## Who does what`,
);

const PACKAGE_JSON = `{
  "name": "class-website",
  "version": "1.0.0",
  "private": true,
  "description": "The website of Class 9B",
  "scripts": {
    "start": "npx --yes http-server -p 8080 -c-1"
  }
}
`;

function page(title: string, nav: string, main: string, scripts = ''): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${title}</title>
    <link rel="stylesheet" href="style.css" />
  </head>
  <body>
    <header class="site-header">
      <h1>Class 9B</h1>
${nav}    </header>
    <main>
${main}    </main>
    <footer>Made by the Class 9B coding club</footer>
${scripts}  </body>
</html>
`;
}

function navBar(links: [string, string][]): string {
  const items = links.map(([href, label]) => `        <a href="${href}">${label}</a>\n`).join('');
  return `      <nav class="menu">\n${items}      </nav>\n`;
}

const HOME_MAIN = `      <section class="welcome">
        <h2>Welcome to our class website!</h2>
        <p>
          We are 28 students who love science, football and terrible jokes. Everything here was
          built by our coding club, one small change at a time.
        </p>
      </section>
      <section id="timetable">
        <h2>This week</h2>
        <ul id="timetable-list"></ul>
      </section>
`;

const HOME_SCRIPTS = `    <script src="src/app.js"></script>
    <script src="script.js"></script>
`;

const NAV_LINKS: [string, string][] = [
  ['index.html', 'Home'],
  ['about.html', 'About us'],
  ['index.html#timetable', 'Timetable'],
];

/** index.html before the navigation bar was merged. */
const INDEX_BEFORE_NAV = page('Class 9B', '', HOME_MAIN, HOME_SCRIPTS);
/** index.html on main: with the navigation bar. */
const INDEX_MAIN = page('Class 9B', navBar(NAV_LINKS), HOME_MAIN, HOME_SCRIPTS);
/** index.html with a Contact link (the contact form submission). */
const INDEX_WITH_CONTACT = page(
  'Class 9B',
  navBar([...NAV_LINKS, ['contact.html', 'Contact']]),
  HOME_MAIN,
  HOME_SCRIPTS,
);

const CONTACT_HTML = page(
  'Contact us · Class 9B',
  navBar([...NAV_LINKS, ['contact.html', 'Contact']]),
  `      <h2>Contact us</h2>
      <p>Questions about the class trip or the science fair? Send us a message.</p>
      <form class="contact-form" action="#" method="post">
        <label for="name">Your name</label>
        <input id="name" name="name" required />

        <label for="email">Your email</label>
        <input id="email" name="email" type="email" required />

        <label for="message">Message</label>
        <textarea id="message" name="message" rows="5" required></textarea>

        <button type="submit">Send</button>
      </form>
`,
);

const ABOUT_HTML = page(
  'About us · Class 9B',
  navBar(NAV_LINKS),
  `      <h2>About us</h2>
      <p>
        Class 9B has 28 students and two class pets: a goldfish called Pixel and a very old
        tortoise called Byte.
      </p>
      <h3>Our favourite things</h3>
      <ul>
        <li>The science fair in March</li>
        <li>Friday football</li>
        <li>Building this website together</li>
      </ul>
`,
);

const GALLERY_HTML = page(
  'Photos · Class 9B',
  navBar([...NAV_LINKS, ['gallery.html', 'Photos']]),
  `      <h2>Our photos</h2>
      <p>Click a photo to see it bigger.</p>
      <div class="gallery">
        <img src="images/science-fair.svg" alt="Our volcano at the science fair" />
        <img src="images/class-trip.svg" alt="The class trip to the museum" />
        <img src="images/football.svg" alt="Friday football" />
      </div>
      <div id="lightbox" class="lightbox" hidden>
        <img id="lightbox-image" alt="" />
      </div>
`,
  `    <script src="script.js"></script>
`,
);

const STYLE_BASE = `/* Class 9B website styles */
:root {
  --brand: #2563eb;
  --text: #1f2937;
  --page: #f9fafb;
}

body {
  margin: 0;
  font-family: system-ui, sans-serif;
  color: var(--text);
  background: var(--page);
  line-height: 1.6;
}

.site-header {
  padding: 1rem 2rem;
  background: var(--brand);
  color: white;
}

main {
  max-width: 48rem;
  margin: 0 auto;
  padding: 1rem 2rem;
}

footer {
  padding: 2rem;
  text-align: center;
  font-size: 0.875rem;
}
`;

const STYLE_MENU = `
.menu {
  display: flex;
  gap: 1rem;
}

.menu a {
  color: white;
  text-decoration: none;
  font-weight: 600;
}

.menu a:hover {
  text-decoration: underline;
}
`;

const STYLE_GALLERY = `
.gallery {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(12rem, 1fr));
  gap: 1rem;
}

.gallery img {
  width: 100%;
  border-radius: 8px;
  cursor: pointer;
}

.lightbox {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.8);
}
`;

const STYLE_DARK = `
body.dark {
  --text: #f3f4f6;
  --page: #111827;
}

.theme-button {
  margin-left: auto;
  padding: 0.25rem 0.75rem;
  border: 1px solid white;
  border-radius: 999px;
  background: transparent;
  color: white;
}
`;

const STYLE_BEFORE_NAV = STYLE_BASE;
const STYLE_MAIN = STYLE_BASE + STYLE_MENU;

const SCRIPT_MAIN = `// Fills in this week's timetable on the home page.
const list = document.getElementById('timetable-list');

if (list) {
  for (const lesson of timetable) {
    const item = document.createElement('li');
    item.textContent = lesson.day + ': ' + lesson.subject;
    list.appendChild(item);
  }
}
`;

const SCRIPT_GALLERY =
  SCRIPT_MAIN +
  `
// Photo gallery: click a photo to open it bigger, click again to close it.
const photos = document.querySelectorAll('img');
const lightbox = document.getElementById('lightbox');
const bigImage = document.getElementById('lightbox-image');

photos.forEach((photo) => {
  photo.addEventListener('click', () => {
    bigImage.src = photo.src;
    bigImage.alt = photo.alt;
    lightbox.hidden = false;
  });
});

lightbox.addEventListener('click', () => {
  lightbox.hidden = true;
});
`;

const SCRIPT_DARK =
  SCRIPT_MAIN +
  `
// Dark mode: a button in the header switches it on and off.
const button = document.createElement('button');
button.className = 'theme-button';
button.textContent = 'Dark mode';
document.querySelector('.site-header').appendChild(button);

button.addEventListener('click', () => {
  document.body.classList.toggle('dark');
});
`;

const APP_JS = `// The class timetable, used by script.js on the home page.
const timetable = [
  { day: 'Monday', subject: 'Maths and coding club' },
  { day: 'Tuesday', subject: 'Science' },
  { day: 'Wednesday', subject: 'English and art' },
  { day: 'Thursday', subject: 'History' },
  { day: 'Friday', subject: 'Sports: football!' },
];
`;

const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="Class 9B">
  <rect width="64" height="64" rx="12" fill="#2563eb" />
  <text x="32" y="41" font-family="system-ui, sans-serif" font-size="24" font-weight="700"
    text-anchor="middle" fill="white">9B</text>
</svg>
`;

/** Main when the demo starts (after the navigation bar was merged). */
export function mainFiles(): Record<string, string> {
  return {
    'README.md': README,
    'index.html': INDEX_MAIN,
    'style.css': STYLE_MAIN,
    'script.js': SCRIPT_MAIN,
    'src/app.js': APP_JS,
    'images/class-logo.svg': LOGO_SVG,
    'package.json': PACKAGE_JSON,
  };
}

/** The versions the sample submissions and copies are made of. */
export const versions = {
  readme: README,
  readmeWithAbout: README_WITH_ABOUT,
  indexBeforeNav: INDEX_BEFORE_NAV,
  indexMain: INDEX_MAIN,
  indexWithContact: INDEX_WITH_CONTACT,
  contactHtml: CONTACT_HTML,
  aboutHtml: ABOUT_HTML,
  galleryHtml: GALLERY_HTML,
  styleBeforeNav: STYLE_BEFORE_NAV,
  styleMain: STYLE_MAIN,
  styleGallery: STYLE_MAIN + STYLE_GALLERY,
  styleDark: STYLE_MAIN + STYLE_DARK,
  scriptMain: SCRIPT_MAIN,
  scriptGallery: SCRIPT_GALLERY,
  scriptDark: SCRIPT_DARK,
};

/** The files of a new project started from the HTML/CSS/JS template in the demo. */
export function htmlTemplateFiles(projectName: string): Record<string, string> {
  return {
    'README.md': `# ${projectName}\n\nA simple web page. Run \`npm start\`, then click Preview (port 8080).\n`,
    'index.html': page(
      projectName,
      '',
      '      <h2>Hello!</h2>\n      <p>Change this page in the IDE.</p>\n',
      '    <script src="script.js"></script>\n',
    ),
    'style.css': STYLE_BASE,
    'script.js': "// Your JavaScript goes here.\nconsole.log('Hello from script.js');\n",
    'package.json': PACKAGE_JSON.replace('class-website', 'my-website'),
  };
}

/** The 1-based number of the first line containing `snippet` (throws if absent: sample data bug). */
export function lineOf(content: string, snippet: string): number {
  const index = content.split('\n').findIndex((line) => line.includes(snippet));
  if (index === -1) throw new Error(`Sample line not found: ${snippet}`);
  return index + 1;
}
