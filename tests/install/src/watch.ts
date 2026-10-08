import type { BrowserContext, Page, Response } from '@playwright/test';

// What every journey watches: a CSP violation, a JavaScript error or a 5xx response fails the
// test, and so does a 4xx the test did not declare as expected.

export interface Expected4xx {
  status: number;
  /** Matched against the path of the request (`/api/…`), without the query. */
  path: RegExp;
  method?: string;
}

export interface Problem {
  kind: 'csp' | 'javascript' | 'console' | 'http';
  text: string;
}

const CSP_MARK = '[install-check:csp]';
// Chromium writes this for every 4xx/5xx; the response itself is judged below.
const FAILED_RESOURCE = /^Failed to load resource/;

/** The path only: a query may carry what somebody searched for. */
function httpText(response: Response): string {
  const { pathname, host } = new URL(response.url());
  return `${response.status()} ${response.request().method()} ${host}${pathname}`;
}

export class Watch {
  readonly #problems: Problem[] = [];
  #expected: Expected4xx[] = [];

  /** Declares a 4xx this test provokes on purpose. Cleared when the test ends. */
  expect4xx(expected: Expected4xx): void {
    this.#expected.push(expected);
  }

  /** The problems seen since the last call, and a clean slate for the next test. */
  drain(): Problem[] {
    this.#expected = [];
    return this.#problems.splice(0);
  }

  /**
   * Takes back the problem of one answer a helper has already dealt with (a code Cognito
   * refused, which the sign-in tries once more). Nothing else of the test is forgiven.
   */
  dismiss(response: Response): void {
    const text = httpText(response);
    const at = this.#problems.findLastIndex(
      (problem) => problem.kind === 'http' && problem.text === text,
    );
    if (at >= 0) this.#problems.splice(at, 1);
  }

  async attach(context: BrowserContext): Promise<void> {
    await context.addInitScript((mark) => {
      document.addEventListener('securitypolicyviolation', (event) => {
        // Runs in the page: this is how a violation reaches the watch below.
        // eslint-disable-next-line no-console
        console.error(`${mark} ${event.violatedDirective} blocked ${event.blockedURI}`);
      });
    }, CSP_MARK);
    for (const page of context.pages()) this.#watchPage(page);
    context.on('page', (page) => {
      this.#watchPage(page);
    });
  }

  #watchPage(page: Page): void {
    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      const text = message.text();
      if (text.startsWith(CSP_MARK)) {
        this.#problems.push({ kind: 'csp', text: text.slice(CSP_MARK.length).trim() });
      } else if (!FAILED_RESOURCE.test(text)) {
        this.#problems.push({ kind: 'console', text: text.slice(0, 400) });
      }
    });
    page.on('pageerror', (error) => {
      this.#problems.push({ kind: 'javascript', text: error.message.slice(0, 400) });
    });
    page.on('response', (response) => {
      const status = response.status();
      if (status < 400) return;
      const request = response.request();
      const { pathname } = new URL(response.url());
      const allowed =
        status < 500 &&
        this.#expected.some(
          (expected) =>
            expected.status === status &&
            expected.path.test(pathname) &&
            (expected.method === undefined || expected.method === request.method()),
        );
      if (allowed) return;
      this.#problems.push({ kind: 'http', text: httpText(response) });
    });
  }
}
