/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_APP_MODE: string;
  readonly VITE_AI_BACKEND_URL: string;
  readonly VITE_PY_BACKEND_URL: string;
  readonly VITE_CONVERSATIONAL_MODE: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
