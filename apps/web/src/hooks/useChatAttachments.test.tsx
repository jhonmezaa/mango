import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ApiError } from '../api/errors';
import { useChatAttachments, type AttachmentUploader } from './useChatAttachments';

const CONVERSATION = 'a'.repeat(32);
const UPLOAD = '01HZZZZZZZZZZZZZZZZZZZZZZZ';
const id = (n: number) => `01HZZZZZZZZZZZZZZZZZZZZZ${String(n).padStart(2, '0')}`;

type Status =
  'uploading' | 'scanning' | 'ready' | 'blocked' | 'type_mismatch' | 'too_large' | 'failed';

/** A fake API and bucket: each announced file gets the next id; `confirm` answers `scans`. */
function fakeUploader(scans: Status[][] = [['ready']]) {
  let next = 0;
  let confirms = 0;
  const posts: string[] = [];
  const uploader: AttachmentUploader = {
    request: vi.fn((_conversation: string, files: { name: string; size: number }[]) =>
      Promise.resolve({
        upload_id: UPLOAD,
        expires_at: '2026-11-08T00:15:00Z',
        files: files.map((file) => {
          if (file.name.endsWith('.html')) return { name: file.name, status: 'unsupported_type' };
          if (file.size > 100 * 1024 * 1024) return { name: file.name, status: 'too_large' };
          next += 1;
          return {
            name: file.name,
            status: 'uploading',
            file_id: id(next),
            url: 'https://bucket.example/',
            fields: { key: 'k' },
          };
        }),
      } as Awaited<ReturnType<AttachmentUploader['request']>>),
    ),
    post: vi.fn((_post, file: File, onProgress: (fraction: number) => void) => {
      posts.push(file.name);
      onProgress(0.5);
      return file.name.includes('falla') && posts.filter((n) => n === file.name).length === 1
        ? Promise.reject(new Error('upload failed'))
        : Promise.resolve();
    }),
    confirm: vi.fn((_conversation: string, _upload: string, fileIds: string[]) => {
      const round = scans[Math.min(confirms, scans.length - 1)] ?? ['ready'];
      confirms += 1;
      return Promise.resolve({
        files: fileIds.map((fileId, index) => ({
          file_id: fileId,
          name: 'x',
          kind: 'csv',
          size_bytes: 1,
          origin: 'upload' as const,
          status: round[Math.min(index, round.length - 1)] ?? 'ready',
          expires_at: '2027-02-06T00:00:00Z',
          gone: false,
        })),
      });
    }),
    wait: vi.fn(() => Promise.resolve()),
  };
  return { uploader, posts };
}

const file = (name: string, size = 10) => new File([new Uint8Array(Math.min(size, 16))], name);
function sized(name: string, size: number): File {
  const f = file(name);
  Object.defineProperty(f, 'size', { value: size });
  return f;
}

function setup(uploader: AttachmentUploader, conversationId: string | null = CONVERSATION) {
  return renderHook(
    ({ scope }: { scope: string }) => useChatAttachments({ uploader, conversationId, scope }),
    { initialProps: { scope: 'c1' } },
  );
}

describe('useChatAttachments', () => {
  it('uploads, follows the scan and lets the message go once every file is ready', async () => {
    const { uploader } = fakeUploader([['scanning'], ['ready']]);
    const { result } = setup(uploader);
    act(() => {
      result.current.add([file('cur.csv')]);
    });
    expect(result.current.items[0]?.status).toBe('uploading');
    expect(result.current.gate).toBe('busy');
    await waitFor(() => {
      expect(result.current.items[0]?.status).toBe('ready');
    });
    expect(result.current.gate).toBeNull();
    expect(result.current.items[0]?.fileId).toBe(id(1));
    // The scan was asked twice: scanning, then ready; between both the composer waited.
    expect(uploader.confirm).toHaveBeenCalledTimes(2);
    expect(uploader.wait).toHaveBeenCalledWith(2000, expect.any(AbortSignal));
    expect(uploader.request).toHaveBeenCalledWith(
      CONVERSATION,
      [{ name: 'cur.csv', size: 10 }],
      expect.any(AbortSignal),
    );
  });

  it('says why the server took no file, and the message waits until it is removed', async () => {
    const { uploader } = fakeUploader();
    const { result } = setup(uploader);
    act(() => {
      result.current.add([file('a.html'), sized('big.csv', 142 * 1024 * 1024), file('ok.pdf')]);
    });
    await waitFor(() => {
      expect(result.current.items.map((item) => item.status)).toEqual([
        'unsupported',
        'too_large',
        'ready',
      ]);
    });
    expect(result.current.gate).toBe('bad');
    act(() => {
      result.current.remove(result.current.items[0]?.id ?? '');
      result.current.remove(result.current.items[1]?.id ?? '');
    });
    expect(result.current.gate).toBeNull();
  });

  it('maps the end of each scan as the composer says it', async () => {
    const { uploader } = fakeUploader([['blocked', 'type_mismatch', 'too_large', 'failed']]);
    const { result } = setup(uploader);
    act(() => {
      result.current.add([file('1.csv'), file('2.csv'), file('3.csv'), file('4.csv')]);
    });
    await waitFor(() => {
      expect(result.current.items.map((item) => item.status)).toEqual([
        'blocked',
        'mismatch',
        'too_large',
        'failed',
      ]);
    });
  });

  it('«Reintentar» announces a failed upload again', async () => {
    const { uploader, posts } = fakeUploader();
    const { result } = setup(uploader);
    act(() => {
      result.current.add([file('falla.csv')]);
    });
    await waitFor(() => {
      expect(result.current.items[0]?.status).toBe('failed');
    });
    act(() => {
      result.current.retry(result.current.items[0]?.id ?? '');
    });
    await waitFor(() => {
      expect(result.current.items[0]?.status).toBe('ready');
    });
    expect(posts).toEqual(['falla.csv', 'falla.csv']);
    expect(uploader.request).toHaveBeenCalledTimes(2);
  });

  it('takes 20 files per message and counts the ones left out', () => {
    const { uploader } = fakeUploader();
    const { result } = setup(uploader);
    act(() => {
      result.current.add(Array.from({ length: 23 }, (_, n) => file(`f${String(n)}.csv`)));
    });
    expect(result.current.items).toHaveLength(20);
    expect(result.current.overflow).toBe(3);
    act(() => {
      result.current.add([file('more.csv')]);
    });
    expect(result.current.items).toHaveLength(20);
    expect(result.current.overflow).toBe(1);
  });

  it('a new chat uploads to the id it will start with; another chat drops the files', async () => {
    const { uploader } = fakeUploader();
    const { result, rerender } = setup(uploader, null);
    const draft = result.current.conversationId;
    expect(draft).toMatch(/^[0-9a-f]{32}$/);
    act(() => {
      result.current.add([file('a.csv')]);
    });
    await waitFor(() => {
      expect(result.current.items[0]?.status).toBe('ready');
    });
    expect(uploader.request).toHaveBeenCalledWith(draft, expect.anything(), expect.anything());
    rerender({ scope: 'c2' });
    expect(result.current.items).toEqual([]);
    expect(result.current.conversationId).not.toBe(draft);
  });

  it('waits what a 429 says and gives up after repeated failures', async () => {
    const { uploader } = fakeUploader();
    vi.mocked(uploader.confirm)
      .mockRejectedValueOnce(new ApiError(429, 'rate_limited', 'slow down', 7))
      .mockRejectedValue(new ApiError(503, 'files_unavailable', 'retry'));
    const { result } = setup(uploader);
    act(() => {
      result.current.add([file('a.csv')]);
    });
    await waitFor(() => {
      expect(result.current.items[0]?.status).toBe('failed');
    });
    expect(uploader.wait).toHaveBeenCalledWith(7000, expect.any(AbortSignal));
    expect(uploader.confirm).toHaveBeenCalledTimes(5);
  });

  it('an empty file is not announced', async () => {
    const { uploader } = fakeUploader();
    const { result } = setup(uploader);
    act(() => {
      result.current.add([new File([], 'empty.csv')]);
    });
    await waitFor(() => {
      expect(result.current.items[0]?.status).toBe('failed');
    });
    expect(uploader.request).not.toHaveBeenCalled();
  });
});
