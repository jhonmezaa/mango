import type { BrowserContext, Response } from '@playwright/test';
import { describe, expect, it } from 'vitest';

import { Watch } from '../src/watch.ts';

// A stand-in for the browser: it only hands the watch the answers a page would get.

function answer(status: number, method: string, url: string): Response {
  return {
    status: () => status,
    url: () => url,
    request: () => ({ method: () => method }),
  } as Response;
}

async function watching(): Promise<{ watch: Watch; receive: (response: Response) => void }> {
  const handlers: ((response: Response) => void)[] = [];
  const page = {
    on: (event: string, handler: (response: Response) => void) => {
      if (event === 'response') handlers.push(handler);
    },
  };
  const context = {
    addInitScript: () => Promise.resolve(),
    pages: () => [page],
    on: () => undefined,
  } as unknown as BrowserContext;
  const watch = new Watch();
  await watch.attach(context);
  return {
    watch,
    receive: (response) => {
      for (const handler of handlers) handler(response);
    },
  };
}

const COGNITO = 'https://cognito-idp.us-east-1.amazonaws.com/';

describe('Watch', () => {
  it('reports a 4xx nobody declared, with the path and without the query', async () => {
    const { watch, receive } = await watching();
    receive(answer(200, 'GET', 'https://app.example.com/api/me'));
    receive(answer(404, 'GET', 'https://app.example.com/api/agents/x?q=nombre'));
    expect(watch.drain()).toEqual([{ kind: 'http', text: '404 GET app.example.com/api/agents/x' }]);
    expect(watch.drain()).toEqual([]);
  });

  it('takes back only the answer a helper dealt with', async () => {
    const { watch, receive } = await watching();
    const refusedCode = answer(400, 'POST', COGNITO);
    receive(refusedCode);
    receive(answer(403, 'GET', 'https://app.example.com/api/admin/audit'));
    watch.dismiss(refusedCode);
    expect(watch.drain()).toEqual([
      { kind: 'http', text: '403 GET app.example.com/api/admin/audit' },
    ]);
  });

  it('takes back one answer at a time: a second refusal is still a problem', async () => {
    const { watch, receive } = await watching();
    receive(answer(400, 'POST', COGNITO));
    receive(answer(400, 'POST', COGNITO));
    watch.dismiss(answer(400, 'POST', COGNITO));
    expect(watch.drain()).toHaveLength(1);
    watch.dismiss(answer(400, 'POST', COGNITO));
    expect(watch.drain()).toEqual([]);
  });
});
