// DevSpace's default VS Code settings for beginners (Phase 12, owner), loaded by the IDE page
// just before VS Code's own workbench.js (the image adds the <script> tag to workbench.html).
// The web client takes default settings only from its embedder's options, not from the server's
// settings files, so this adds them to the page's workbench configuration:
// - VS Code's own AI chat (Copilot) is off: it needs a GitHub account; Cline is the assistant;
// - no "Setup VS Code Web" walkthrough on start;
// - the secondary side bar (where VS Code puts its chat) starts hidden, and the chat button in the
//   title bar is gone.
// They are defaults: a member can still change them.
/* global document -- runs in the browser, on VS Code's page */
const meta = document.getElementById('vscode-workbench-web-configuration');
const raw = meta?.getAttribute('data-settings');
if (meta && raw) {
  const config = JSON.parse(raw);
  config.configurationDefaults = {
    ...config.configurationDefaults,
    'chat.disableAIFeatures': true,
    'workbench.startupEditor': 'none',
    'workbench.secondarySideBar.defaultVisibility': 'hidden',
    'chat.commandCenter.enabled': false,
  };
  meta.setAttribute('data-settings', JSON.stringify(config));
}
