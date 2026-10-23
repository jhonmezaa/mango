import { afterEach, describe, expect, it, vi } from 'vitest';

import { postFile, uploadTarget } from './upload';

const ORIGIN = 'https://mango.example.com';

describe('uploadTarget', () => {
  it('takes the bucket over https, or this origin (the local mock)', () => {
    expect(uploadTarget('https://bucket.s3.us-east-1.amazonaws.com/', ORIGIN)?.href).toBe(
      'https://bucket.s3.us-east-1.amazonaws.com/',
    );
    expect(uploadTarget(`${ORIGIN}/mock-s3/a/b`, ORIGIN)).not.toBeNull();
  });

  it('refuses anything else', () => {
    expect(uploadTarget('http://bucket.s3.amazonaws.com/', ORIGIN)).toBeNull();
    expect(uploadTarget('javascript:alert(1)', ORIGIN)).toBeNull();
    expect(uploadTarget('https://user:pass@bucket.s3.amazonaws.com/', ORIGIN)).toBeNull();
    expect(uploadTarget('http://[', ORIGIN)).toBeNull();
  });
});

class FakeRequest {
  static last: FakeRequest | null = null;
  status = 0;
  withCredentials = true;
  method = '';
  url = '';
  body: FormData | null = null;
  upload: { onprogress: ((event: ProgressEvent) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  constructor() {
    FakeRequest.last = this;
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  send(body: FormData) {
    this.body = body;
  }
  abort() {
    this.onabort?.();
  }
}

describe('postFile', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts the signed fields in order, then the file, without credentials', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeRequest);
    const progress: number[] = [];
    const file = new File(['hola'], 'a.txt', { type: 'text/plain' });
    const done = postFile(
      { url: 'https://bucket.s3.amazonaws.com/', fields: { key: 'uploads/u/d', Policy: 'p' } },
      file,
      (fraction) => progress.push(fraction),
      new AbortController().signal,
    );
    const request = FakeRequest.last;
    if (!request?.body) throw new Error('no request');
    expect([request.method, request.url, request.withCredentials]).toEqual([
      'POST',
      'https://bucket.s3.amazonaws.com/',
      false,
    ]);
    expect([...request.body.keys()]).toEqual(['key', 'Policy', 'file']);
    request.upload.onprogress?.({ lengthComputable: true, loaded: 2, total: 4 } as ProgressEvent);
    request.status = 204;
    request.onload?.();
    await expect(done).resolves.toBeUndefined();
    expect(progress).toEqual([0.5]);
  });

  it('fails when the bucket refuses the file, and never posts to a refused target', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeRequest);
    const file = new File(['x'], 'a.txt');
    const done = postFile(
      { url: 'https://bucket.s3.amazonaws.com/', fields: {} },
      file,
      () => undefined,
      new AbortController().signal,
    );
    const request = FakeRequest.last;
    if (!request) throw new Error('no request');
    request.status = 403;
    request.onload?.();
    await expect(done).rejects.toThrow('upload failed: 403');
    FakeRequest.last = null;
    await expect(
      postFile(
        { url: 'http://evil.example.com/', fields: {} },
        file,
        () => undefined,
        new AbortController().signal,
      ),
    ).rejects.toThrow('upload target refused');
    expect(FakeRequest.last).toBeNull();
  });
});
