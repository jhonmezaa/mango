import { afterEach, describe, expect, it, vi } from 'vitest';

import { copyText } from './clipboard';

describe('copyText', () => {
  const descriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  afterEach(() => {
    if (descriptor) Object.defineProperty(navigator, 'clipboard', descriptor);
    else Reflect.deleteProperty(navigator, 'clipboard');
  });

  it('writes through the Clipboard API when it exists', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await copyText('hola');
    expect(writeText).toHaveBeenCalledWith('hola');
  });

  it('rejects instead of throwing without the Clipboard API (insecure context)', async () => {
    Reflect.deleteProperty(navigator, 'clipboard');
    // A synchronous throw would escape the caller's `.then(…, onError)`.
    let pending: Promise<void> | undefined;
    expect(() => {
      pending = copyText('hola');
    }).not.toThrow();
    await expect(pending).rejects.toThrow('clipboard unavailable');
  });
});
