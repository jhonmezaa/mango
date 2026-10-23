// The browser half of a document upload (D88 (30)): each file goes straight to the documents bucket
// with the POST that mango-api signed for it. The form is the fields the API returned, in order,
// then the file. Nothing of the session travels: no cookies, no Authorization header.

export interface SignedPost {
  url: string;
  fields: Record<string, string>;
}

/**
 * Only an https URL (the bucket, which the CSP's `connect-src` names) or this origin (the local
 * mock). Anything else the API might ever send is refused before a byte leaves the browser.
 */
export function uploadTarget(url: string, origin: string = window.location.origin): URL | null {
  let target: URL;
  try {
    target = new URL(url, origin);
  } catch {
    return null;
  }
  if (target.username || target.password) return null;
  return target.protocol === 'https:' || target.origin === origin ? target : null;
}

/**
 * Posts one file and reports its progress (0 to 1). `fetch` has no upload progress, so this is an
 * XMLHttpRequest. Resolves when S3 accepts it; rejects on anything else, or when aborted.
 */
export function postFile(
  post: SignedPost,
  file: File,
  onProgress: (fraction: number) => void,
  signal: AbortSignal,
): Promise<void> {
  const target = uploadTarget(post.url);
  if (!target) return Promise.reject(new Error('upload target refused'));
  const form = new FormData();
  for (const [name, value] of Object.entries(post.fields)) form.append(name, value);
  form.append('file', file);
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', target.href);
    request.withCredentials = false;
    request.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total);
    };
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) resolve();
      else reject(new Error(`upload failed: ${String(request.status)}`));
    };
    request.onerror = () => {
      reject(new Error('upload failed'));
    };
    request.onabort = () => {
      reject(new Error('upload aborted'));
    };
    if (signal.aborted) {
      reject(new Error('upload aborted'));
      return;
    }
    signal.addEventListener('abort', () => {
      request.abort();
    });
    request.send(form);
  });
}
