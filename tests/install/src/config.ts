import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import { createRedactor, type Literal, type Redactor } from './redact.ts';

// What the suite needs to know about one installation. It lives in a local file outside the
// repository (`MANGO_INSTALL_CONFIG`); `config.example.json` shows its shape with placeholders.

export const ROLES = ['admin', 'secondAdmin', 'creator', 'areaMember', 'plain'] as const;
export type Role = (typeof ROLES)[number];

export const EFFECTS = ['chat', 'people'] as const;
export type Effect = (typeof EFFECTS)[number];

const user = z.strictObject({ email: z.email() });

const schema = z.strictObject({
  /** Origin of the installation (the `AppUrl` output of `Mango-<ns>-Core`). */
  baseUrl: z
    .url({ protocol: /^https$/ })
    .refine((value) => new URL(value).pathname === '/', 'Only the origin, without a path.'),
  /** JSON file `{ "<email>": { "password": "…", "totp": "<base32 secret>" } }`. */
  secretsFile: z.string().min(1),
  /** Where reports and screenshots go. Default: `~/.config/mango/install-check`. */
  outputDir: z.string().min(1).optional(),
  /** Test users by role. A journey whose role is missing is skipped, and the report says so. */
  users: z.strictObject({
    admin: user.optional(),
    secondAdmin: user.optional(),
    creator: user.optional(),
    areaMember: user.optional(),
    plain: user.optional(),
  }),
  /** Release label the installation must show (`v0.1.0-g…`). Optional: without it, only reported. */
  release: z.string().min(1).optional(),
  /** Journey with effect `chat`: one short question that makes the agent call a tool. */
  chat: z
    .strictObject({
      role: z.enum(ROLES).default('areaMember'),
      agent: z.string().min(1),
      question: z.string().min(1).max(500),
    })
    .optional(),
  /** Journey with effect `people`: the disposable person is `install-check-<random>@<emailDomain>`. */
  people: z
    .strictObject({
      // RFC 2606: nothing is ever delivered to `.invalid`, and nobody owns such an address.
      emailDomain: z.string().regex(/^[a-z0-9-]+(\.[a-z0-9-]+)*\.invalid$/),
    })
    .optional(),
  /**
   * What the suite does with the AWS CLI. The user pool and the region are read from the
   * installation (`/config.json`). `profile`: to delete the disposable person at the end;
   * without credentials the person stays disabled. `namespace` (the `<ns>` of
   * `Mango-<ns>-Core`): the read-only run also asks AgentCore whether the harness of each
   * agent of the release exists; without it that question is not asked and the report says so.
   */
  aws: z
    .strictObject({
      profile: z.string().min(1).optional(),
      namespace: z
        .string()
        .regex(/^[a-z0-9]{3,8}$/)
        .optional(),
    })
    .optional(),
});

const secretsSchema = z.record(
  z.string(),
  z.looseObject({ password: z.string().min(1), totp: z.string().min(1) }),
);

export type InstallFile = z.infer<typeof schema>;

export interface InstallConfig extends InstallFile {
  /** Directory of this run: report, result and screenshots. */
  runDir: string;
  /** When the run began (ISO), the same in every worker. */
  startedAt: string;
  ledgerFile: string;
  effects: ReadonlySet<Effect>;
}

export interface Credentials {
  email: string;
  password: string;
  totp: string;
}

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** A path of the configuration never points inside the repository: it would end up in a commit. */
export function assertOutsideRepo(path: string, what: string, repoRoot = REPO_ROOT): void {
  const inside = relative(repoRoot, path);
  if (inside === '' || (!inside.startsWith('..') && !isAbsolute(inside))) {
    throw new Error(`${what} must be outside the repository.`);
  }
}

export function parseEffects(value: string | undefined): ReadonlySet<Effect> {
  const asked = (value ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
  if (asked.includes('all')) return new Set(EFFECTS);
  const unknown = asked.filter((part) => !(EFFECTS as readonly string[]).includes(part));
  if (unknown.length > 0) {
    throw new Error(`MANGO_INSTALL_EFFECTS accepts ${EFFECTS.join(', ')} or all.`);
  }
  return new Set(asked as Effect[]);
}

/** Parses the configuration file; errors name the field, never its value. */
export function parseInstallFile(raw: unknown): InstallFile {
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const fields = parsed.error.issues.map((issue) => issue.path.join('.') || '(root)');
  throw new Error(`Invalid installation config, check: ${[...new Set(fields)].join(', ')}.`);
}

let cached: InstallConfig | undefined;

/** The configuration of this run, read once per process from `MANGO_INSTALL_CONFIG`. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): InstallConfig {
  if (cached) return cached;
  const path = env.MANGO_INSTALL_CONFIG;
  if (!path) {
    throw new Error(
      'MANGO_INSTALL_CONFIG is not set: point it to the config file of the installation ' +
        '(see tests/install/README.md).',
    );
  }
  const file = resolve(path);
  assertOutsideRepo(file, 'The installation config');
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new Error('The installation config cannot be read or is not JSON.');
  }
  const parsed = parseInstallFile(raw);
  const secretsFile = resolve(dirname(file), parsed.secretsFile);
  assertOutsideRepo(secretsFile, 'The secrets file');
  const outputDir = resolve(
    dirname(file),
    parsed.outputDir ?? resolve(homedir(), '.config', 'mango', 'install-check'),
  );
  assertOutsideRepo(outputDir, 'The output directory');
  // The main process names the run; workers inherit it through the environment.
  env.MANGO_INSTALL_RUN_STARTED ??= new Date().toISOString();
  env.MANGO_INSTALL_RUN_ID ??= env.MANGO_INSTALL_RUN_STARTED.replace(/[:.]/g, '-');
  cached = {
    ...parsed,
    baseUrl: new URL(parsed.baseUrl).origin,
    secretsFile,
    outputDir,
    runDir: resolve(outputDir, env.MANGO_INSTALL_RUN_ID),
    startedAt: env.MANGO_INSTALL_RUN_STARTED,
    ledgerFile: resolve(outputDir, '.totp-windows.json'),
    effects: parseEffects(env.MANGO_INSTALL_EFFECTS),
  };
  return cached;
}

function readSecrets(config: InstallConfig): z.infer<typeof secretsSchema> {
  try {
    return secretsSchema.parse(JSON.parse(readFileSync(config.secretsFile, 'utf8')));
  } catch {
    throw new Error('The secrets file cannot be read or does not have the expected shape.');
  }
}

/** Password and TOTP secret of a role, read when needed and never kept by the suite. */
export function credentialsOf(config: InstallConfig, role: Role): Credentials {
  const email = config.users[role]?.email;
  if (!email) throw new Error(`No user is configured for the role ${role}.`);
  const entry = readSecrets(config)[email];
  if (!entry) throw new Error(`The secrets file has no entry for the role ${role}.`);
  return { email, password: entry.password, totp: entry.totp };
}

/** Masks, in any text, what this run knows: the host, the test users and their secrets. */
export function redactorOf(config: InstallConfig): Redactor {
  const literals: Literal[] = [{ value: new URL(config.baseUrl).host, label: 'instalación' }];
  let secrets: z.infer<typeof secretsSchema> = {};
  try {
    secrets = readSecrets(config);
  } catch {
    // Without the secrets file there is nothing of it to mask; sign-in reports the problem.
  }
  for (const role of ROLES) {
    const email = config.users[role]?.email;
    if (!email) continue;
    literals.push({ value: email, label: role });
    literals.push({ value: email.split('@')[0] ?? email, label: role });
    const entry = secrets[email];
    if (entry) {
      literals.push({ value: entry.password, label: 'secreto' });
      literals.push({ value: entry.totp, label: 'secreto' });
    }
  }
  return createRedactor(literals);
}
