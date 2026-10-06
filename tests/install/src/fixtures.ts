import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  test as base,
  expect,
  type Browser,
  type BrowserContext,
  type Page,
  type TestInfo,
} from '@playwright/test';
import { z } from 'zod';

import { credentialsOf, loadConfig, type Effect, type InstallConfig, type Role } from './config.ts';
import { SCREEN_SHAPES } from './redact.ts';
import { signIn, signOut } from './session.ts';
import { TotpLedger } from './totp.ts';
import { Watch, type Expected4xx } from './watch.ts';

// Fixtures shared by every journey: one browser session per role (signed in once per worker,
// always signed out), the common watch, and masked screenshots when a test fails.

const meSchema = z.looseObject({
  user_id: z.string(),
  is_admin: z.boolean(),
  groups: z.array(z.string()),
  can: z.looseObject({ create_agent: z.boolean() }),
});
export type Me = z.infer<typeof meSchema>;

export interface ApiAnswer {
  status: number;
  body: unknown;
  /** `error.code` of a refused call, when the body has one. */
  code: string | null;
}

export interface Session {
  role: Role;
  context: BrowserContext;
  page: Page;
  me: Me;
  /** Calls the API as this person, with the token of the browser session (never printed). */
  api: (method: string, path: string, data?: unknown) => Promise<ApiAnswer>;
  /** Declares a 4xx this test provokes on purpose in this browser. */
  expect4xx: (expected: Expected4xx) => void;
}

interface Opened extends Session {
  watch: Watch;
  close: () => Promise<void>;
}

const errorCode = z.looseObject({ error: z.looseObject({ code: z.string() }) });

async function watched(browser: Browser, config: InstallConfig) {
  const context = await browser.newContext({
    baseURL: config.baseUrl,
    locale: 'es-MX',
    viewport: { width: 1440, height: 900 },
    colorScheme: 'light',
  });
  const watch = new Watch();
  await watch.attach(context);
  return { context, watch };
}

async function open(
  browser: Browser,
  config: InstallConfig,
  ledger: TotpLedger,
  role: Role,
): Promise<Opened> {
  const { context, watch } = await watched(browser, config);
  // The access token the SPA sends, kept in memory only, to call the API as this person.
  let bearer: string | undefined;
  context.on('request', (request) => {
    const header = request.headers().authorization;
    if (header && request.url().startsWith(`${config.baseUrl}/api/`)) bearer = header;
  });
  const call = async (method: string, path: string, data?: unknown): Promise<ApiAnswer> => {
    if (!bearer) throw new Error('The browser session has not sent a token yet.');
    const response = await context.request.fetch(path, {
      method,
      headers: { Authorization: bearer, Accept: 'application/json' },
      ...(data === undefined ? {} : { data }),
    });
    const body: unknown = await response.json().catch(() => null);
    const refused = errorCode.safeParse(body);
    return {
      status: response.status(),
      body,
      code: refused.success ? refused.data.error.code : null,
    };
  };
  const page = await context.newPage();
  let signedIn = false;
  const close = async () => {
    try {
      if (signedIn) await leave(page, context, config);
    } finally {
      bearer = undefined;
      await context.close();
    }
  };
  try {
    const answered = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/me' && response.ok(),
    );
    answered.catch(() => undefined);
    await signIn(page, credentialsOf(config, role), ledger);
    signedIn = true;
    const me = meSchema.parse(await (await answered).json());
    return {
      role,
      context,
      page,
      me,
      api: call,
      watch,
      close,
      expect4xx: (expected) => {
        watch.expect4xx(expected);
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}

/**
 * Ends a session whatever state its page was left in: through the account menu, and if that
 * fails, with the request the menu would have sent. A session is never left open on the server.
 */
async function leave(page: Page, context: BrowserContext, config: InstallConfig): Promise<void> {
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    const ended = await signOut(page);
    if (ended.status() === 204) return;
  } catch {
    // Falls through to the direct request.
  }
  const ended = await context.request.delete('/api/session', {
    headers: { Origin: config.baseUrl, 'Sec-Fetch-Site': 'same-origin' },
  });
  if (ended.status() !== 204) throw new Error('A session could not be closed: check Auditoría.');
}

/** Screenshot with addresses and ids covered, into the directory of the run. */
export async function maskedShot(page: Page, config: InstallConfig, name: string): Promise<string> {
  const dir = join(config.runDir, 'capturas');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name.replace(/[^\w-]+/g, '-').slice(0, 120)}.png`);
  await page.screenshot({
    path,
    mask: SCREEN_SHAPES.map((shape) => page.getByText(shape)),
    maskColor: '#888888',
    animations: 'disabled',
  });
  return path;
}

/** Writes in the report what a journey leaves in the installation. */
export function leaves(testInfo: TestInfo, text: string): void {
  testInfo.annotations.push({ type: 'leaves', description: text });
}

/** Writes a fact of the run in the report (the release, an attempt count). */
export function note(testInfo: TestInfo, text: string): void {
  testInfo.annotations.push({ type: 'note', description: text });
}

interface WorkerFixtures {
  config: InstallConfig;
  ledger: TotpLedger;
  pool: {
    get: (role: Role) => Promise<Opened>;
    all: () => Opened[];
    extra: Set<{ context: BrowserContext; watch: Watch }>;
  };
}

interface TestFixtures {
  /** The session of a role; the test is skipped, with the reason, if the role has no user. */
  as: (role: Role) => Promise<Session>;
  /** A browser of its own for a journey that signs in and out by itself. Closed at the end. */
  ownBrowser: () => Promise<{ context: BrowserContext; page: Page; watch: Watch }>;
  /** Skips the test unless its effect was asked for with `MANGO_INSTALL_EFFECTS`. */
  needsEffect: (effect: Effect) => void;
  /** The roles whose session this worker holds open right now. */
  openRoles: () => Role[];
  guard: undefined;
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
  config: [
    // eslint-disable-next-line no-empty-pattern -- Playwright reads the fixture names from here.
    async ({}, use) => {
      await use(loadConfig());
    },
    { scope: 'worker' },
  ],
  ledger: [
    async ({ config }, use) => {
      await use(new TotpLedger(config.ledgerFile));
    },
    { scope: 'worker' },
  ],
  pool: [
    async ({ browser, config, ledger }, use) => {
      const sessions = new Map<Role, Opened>();
      const extra = new Set<{ context: BrowserContext; watch: Watch }>();
      await use({
        get: async (role) => {
          const existing = sessions.get(role);
          if (existing) return existing;
          const opened = await open(browser, config, ledger, role);
          sessions.set(role, opened);
          return opened;
        },
        all: () => [...sessions.values()],
        extra,
      });
      const failures: unknown[] = [];
      for (const session of sessions.values())
        await session.close().catch((e: unknown) => failures.push(e));
      if (failures.length > 0) throw new Error('A session could not be closed: check Auditoría.');
    },
    { scope: 'worker', timeout: 120_000 },
  ],
  as: async ({ pool, config }, use) => {
    await use(async (role) => {
      test.skip(!config.users[role], `no hay usuario configurado para el papel «${role}»`);
      return pool.get(role);
    });
  },
  ownBrowser: async ({ browser, config, pool }, use) => {
    const opened: { context: BrowserContext; watch: Watch }[] = [];
    await use(async () => {
      const one = await watched(browser, config);
      opened.push(one);
      pool.extra.add(one);
      return { ...one, page: await one.context.newPage() };
    });
    for (const one of opened) {
      pool.extra.delete(one);
      await one.context.close();
    }
  },
  openRoles: async ({ pool }, use) => {
    await use(() => pool.all().map((session) => session.role));
  },
  needsEffect: async ({ config }, use) => {
    await use((effect) => {
      test.skip(
        !config.effects.has(effect),
        `recorrido con efecto: se pide con MANGO_INSTALL_EFFECTS=${effect}`,
      );
    });
  },
  guard: [
    async ({ pool, config }, use, testInfo) => {
      await use(undefined);
      const watchedNow = [...pool.all(), ...pool.extra];
      if (testInfo.status !== testInfo.expectedStatus && testInfo.status !== 'skipped') {
        let n = 0;
        for (const { context } of watchedNow) {
          for (const page of context.pages()) {
            n += 1;
            await maskedShot(page, config, `${testInfo.title}-${n}`).catch(() => undefined);
          }
        }
      }
      const problems = watchedNow.flatMap(({ watch }) => watch.drain());
      expect(problems, 'CSP, JavaScript errors, 5xx and undeclared 4xx').toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
