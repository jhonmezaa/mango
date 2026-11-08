/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Only the end-to-end build sets it: the SPA's origin may then be `http` on the loopback. */
  readonly VITE_SANDBOX_LOOPBACK?: string;
}
