import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import type { RunRequest } from '../src/protocol';

const MATPLOTLIB = existsSync(
  join(
    import.meta.dirname,
    '..',
    'dist',
    'vendor',
    'pyodide',
    '0.26.4',
    'matplotlib-3.5.2-cp312-cp312-pyodide_2024_0_wasm32.whl',
  ),
);

async function run(page: Page, request: RunRequest) {
  await page.goto('/');
  return page.evaluate((r) => window.runInSandbox(r), request);
}

/** Every event of the session so far, as the host got them. */
function events(page: Page) {
  return page.evaluate(() => window.sandboxEvents);
}

/** The inner frame of the runner (the only frame inside the runner's frame). */
function inner(page: Page) {
  return page.frameLocator('#slot iframe').frameLocator('iframe');
}

test('runs HTML in the inner frame, which cannot reach the host nor the network', async ({
  page,
}) => {
  const result = await run(page, {
    kind: 'html',
    source: [
      '<p id="out">hola</p>',
      '<script>',
      'let leaks = [];',
      'try { leaks.push(String(parent.document.title)); } catch { leaks.push("no-parent"); }',
      'try { leaks.push(String(top.document.title)); } catch { leaks.push("no-top"); }',
      'try { localStorage.setItem("x", "1"); leaks.push("storage"); } catch { leaks.push("no-storage"); }',
      'fetch("https://example.com/?d=1").then(() => leaks.push("fetch"), () => leaks.push("no-fetch"))',
      '  .finally(() => { document.getElementById("out").textContent = leaks.join(","); });',
      '</script>',
    ].join('\n'),
  });
  expect(result.error).toBeNull();
  expect(result.ok).toBe(true);
  await expect(inner(page).locator('#out')).toHaveText('no-parent,no-top,no-storage,no-fetch');
  // Events and the answer travel on different ports: the event may come after the answer.
  await expect
    .poll(() => page.evaluate(() => window.sandboxEvents.some((e) => e.type === 'complete')))
    .toBe(true);
});

test('reports a blocked request as a CSP violation', async ({ page }) => {
  const result = await run(page, {
    kind: 'html',
    source: '<img src="https://example.com/pixel.png?d=secret">',
  });
  expect(result.ok).toBe(true);
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.sandboxEvents.map((e) => e.type === 'csp-violation' && e.directive),
      ),
    )
    .toContain('img-src');
});

test('runs a React component with Recharts and Tailwind from the mirror', async ({ page }) => {
  const result = await run(page, {
    kind: 'react',
    source: [
      "import { useState } from 'react';",
      "import { LineChart, Line, XAxis } from 'recharts';",
      'const data = [{ x: 1, y: 2 }, { x: 2, y: 5 }, { x: 3, y: 3 }];',
      'export default function App(): JSX.Element {',
      '  const [n, setN] = useState<number>(0);',
      '  return (',
      '    <div className="p-4 text-lg">',
      '      <button id="b" onClick={() => setN(n + 1)}>clics {n}</button>',
      '      <LineChart width={300} height={200} data={data}><XAxis dataKey="x" /><Line dataKey="y" /></LineChart>',
      '    </div>',
      '  );',
      '}',
    ].join('\n'),
  });
  expect(result.error).toBeNull();
  expect((await events(page)).filter((e) => e.type === 'error')).toEqual([]);
  expect(result.ok).toBe(true);
  const frame = inner(page);
  await frame.locator('#b').click();
  await expect(frame.locator('#b')).toHaveText('clics 1');
  await expect(frame.locator('svg.recharts-surface')).toBeVisible();
  // Tailwind (browser build) generated the class.
  await expect(frame.locator('div.p-4')).toHaveCSS('padding-top', '16px');
});

test('a React error is reported, not thrown at the host', async ({ page }) => {
  const result = await run(page, {
    kind: 'react',
    source: "export default function App() { throw new Error('roto'); }",
  });
  expect(result.ok).toBe(false);
  await expect
    .poll(async () =>
      (await events(page)).some((e) => e.type === 'error' && e.message.includes('roto')),
    )
    .toBe(true);
});

test('a module outside the mirror cannot be imported', async ({ page }) => {
  const result = await run(page, {
    kind: 'react',
    source: "import confetti from 'https://example.com/confetti.js'; export default () => null;",
  });
  expect(result.ok).toBe(false);
});

test('runs Python with the Pyodide of the mirror', async ({ page }) => {
  const result = await run(page, {
    kind: 'python',
    source: 'import sys\nprint("hola", sys.version_info.major)\n',
  });
  expect(result.error).toBeNull();
  expect(result.ok).toBe(true);
  await expect(inner(page).locator('#console')).toContainText('hola 3');
  await expect
    .poll(async () => (await events(page)).flatMap((e) => (e.type === 'status' ? [e.phase] : [])))
    .toEqual(['initializing', 'loading-packages', 'running']);
});

test('reports a Python error with its line', async ({ page }) => {
  const result = await run(page, { kind: 'python', source: 'x = 1\nraise ValueError("mal")\n' });
  expect(result.ok).toBe(false);
  await expect
    .poll(async () =>
      (await events(page)).some(
        (e) => e.type === 'error' && e.message.includes('ValueError') && e.line === 2,
      ),
    )
    .toBe(true);
});

test('draws matplotlib with AGG as a PNG', async ({ page }) => {
  test.skip(!MATPLOTLIB, 'the Pyodide packages are only in the mirror after vendor:pyodide');
  const result = await run(page, {
    kind: 'python',
    source: [
      'import matplotlib.pyplot as plt',
      'import pandas as pd',
      'df = pd.DataFrame({"x": [1, 2, 3], "y": [3, 1, 2]})',
      'plt.plot(df.x, df.y)',
      'print(df.y.sum())',
    ].join('\n'),
  });
  expect(result.error).toBeNull();
  expect(result.ok).toBe(true);
  await expect(inner(page).locator('#console')).toContainText('6');
  await expect(inner(page).locator('#figures img')).toHaveAttribute(
    'src',
    /^data:image\/png;base64,/,
  );
});
