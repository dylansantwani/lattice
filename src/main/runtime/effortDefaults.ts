/**
 * Per-model default reasoning tier — the implementation lives in `src/shared/effortDefaults.ts` so
 * the renderer's model browser can show the tier a model will start on, using the very same
 * resolution the main process applies when a thread is created or switched. This module keeps the
 * historical import path for the main process.
 */
export * from '@shared/effortDefaults'
