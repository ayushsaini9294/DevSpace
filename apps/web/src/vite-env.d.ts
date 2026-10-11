/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** `1` builds the demo: sample data answered in the browser, no server (see src/demo). */
  readonly VITE_DEMO?: string;
  /** Demo only: the public repository, linked from the demo banner (hidden when unset). */
  readonly VITE_DEMO_REPO_URL?: string;
  /** Demo only: the video of the real system, linked from the banner and the IDE page. */
  readonly VITE_DEMO_VIDEO_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
