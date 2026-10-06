import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { z } from 'zod';

import type { InstallConfig } from './config.ts';

// The one thing the suite does outside the application: deleting, in the user pool, the
// disposable person its own run invited. With the AWS CLI and the credentials of who runs the
// suite. The output of the CLI is parsed and never echoed.

const run = promisify(execFile);

const user = z.object({
  UserStatus: z.string(),
  UserAttributes: z.array(z.object({ Name: z.string(), Value: z.string() })),
});

export type Deleted = 'deleted' | 'no-credentials' | 'not-the-disposable-person';

interface Target {
  profile: string | undefined;
  region: string;
  userPoolId: string;
}

async function aws(target: Target, args: string[]): Promise<string> {
  const { stdout } = await run(
    'aws',
    [
      ...args,
      '--region',
      target.region,
      '--output',
      'json',
      ...(target.profile ? ['--profile', target.profile] : []),
    ],
    { env: { ...process.env, AWS_PAGER: '' }, timeout: 60_000 },
  );
  return stdout;
}

/**
 * Deletes the account only if it is the one this run invited: the address and the id match,
 * and it never signed in (it still waits for its first password).
 */
export async function deleteDisposable(
  config: InstallConfig,
  pool: { region: string; userPoolId: string },
  person: { email: string; userId: string },
): Promise<Deleted> {
  if (!config.aws) return 'no-credentials';
  const target: Target = { profile: config.aws.profile, ...pool };
  try {
    await aws(target, ['sts', 'get-caller-identity']);
  } catch {
    return 'no-credentials';
  }
  const who = ['--user-pool-id', target.userPoolId, '--username', person.email];
  const found = user.parse(
    JSON.parse(await aws(target, ['cognito-idp', 'admin-get-user', ...who])),
  );
  const attribute = (name: string) => found.UserAttributes.find((a) => a.Name === name)?.Value;
  const disposable =
    attribute('email') === person.email &&
    attribute('sub') === person.userId &&
    found.UserStatus === 'FORCE_CHANGE_PASSWORD';
  if (!disposable) return 'not-the-disposable-person';
  await aws(target, ['cognito-idp', 'admin-delete-user', ...who]);
  return 'deleted';
}
