/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_APP_MODE: string;
  readonly VITE_AI_BACKEND_URL: string;
  readonly VITE_PY_BACKEND_URL: string;
  readonly VITE_CONVERSATIONAL_MODE: string;
  readonly VITE_APP_TOKEN: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** Injected by vite define from package.json version */
declare const __APP_VERSION__: string;
