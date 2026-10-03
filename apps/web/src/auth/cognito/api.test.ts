import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { CognitoError, createCognitoCall } from './api';

const ENDPOINT = 'https://cognito-idp.us-east-1.amazonaws.com/';

function respond(status: number, body: unknown) {
  return vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status })));
}

describe('Cognito API client', () => {
  it('posts JSON with the operation target and no credentials', async () => {
    const fetchImpl = respond(200, { ok: true });
    const call = createCognitoCall(ENDPOINT, fetchImpl);
    await call('SignUp', { ClientId: 'c' }, z.object({ ok: z.boolean() }));
    expect(fetchImpl).toHaveBeenCalledWith(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-amz-json-1.1',
        'X-Amz-Target': 'AWSCognitoIdentityProviderService.SignUp',
      },
      body: '{"ClientId":"c"}',
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
    });
  });

  it.each([
    [
      { __type: 'NotAuthorizedException', message: 'Incorrect username or password.' },
      'NotAuthorizedException',
    ],
    [{ __type: 'com.amazonaws.cognito#CodeMismatchException' }, 'CodeMismatchException'],
    [{ message: 'secret-password in body' }, 'Http400'],
    [{ __type: '<script>' }, 'Http400'],
  ])('keeps only the exception name of %j', async (body, code) => {
    const call = createCognitoCall(ENDPOINT, respond(400, body));
    const error = await call('InitiateAuth', {}, z.object({})).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CognitoError);
    expect((error as CognitoError).code).toBe(code);
    expect((error as CognitoError).message).not.toContain('password');
  });

  it('maps network failures and unexpected bodies', async () => {
    const offline = createCognitoCall(
      ENDPOINT,
      vi.fn(() => Promise.reject(new TypeError('x'))),
    );
    await expect(offline('SignUp', {}, z.object({}))).rejects.toMatchObject({
      code: 'NetworkError',
    });
    const odd = createCognitoCall(ENDPOINT, respond(200, { AccessToken: 1 }));
    await expect(odd('SignUp', {}, z.object({ AccessToken: z.string() }))).rejects.toMatchObject({
      code: 'InvalidResponse',
    });
  });
});
