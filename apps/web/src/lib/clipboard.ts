/**
 * Writes text to the clipboard. `navigator.clipboard` only exists in secure contexts (HTTPS,
 * localhost), so a missing API rejects like a denied permission instead of throwing.
 */
export function copyText(text: string): Promise<void> {
  if (!('clipboard' in navigator)) return Promise.reject(new Error('clipboard unavailable'));
  return navigator.clipboard.writeText(text);
}
