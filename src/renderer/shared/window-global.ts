import type { SarahApi } from '../../core/sarah-api.js';

declare global {
  interface Window {
    __sarah?: SarahApi;
    sarah?: SarahApi;
  }
}

export function installSarah(api: SarahApi): void {
  window.__sarah = api;
}

export function getSarah(): SarahApi {
  const api = window.__sarah ?? window.sarah;
  if (!api) throw new Error('SarahApi is not installed on window');
  return api;
}
