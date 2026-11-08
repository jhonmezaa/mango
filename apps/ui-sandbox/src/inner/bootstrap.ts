/**
 * The bootstrap of an inner frame: the first script of its `srcdoc`, right after its `<meta>`
 * policy. It takes the one port the runner hands over and runs what arrives on it. It is as
 * untrusted as the code it runs (same opaque origin): the runner believes nothing it says, and
 * it never writes received text as HTML (output goes in as text, figures as `data:` images).
 */

interface Job {
  /** Whatever arrived on the port: checked here, not assumed. */
  readonly kind: string;
  readonly source: string;
  readonly pythonWorker?: string;
  readonly pyodideUrl?: string;
}

interface BabelStandalone {
  transform(code: string, options: Record<string, unknown>): { code: string | null };
}

interface ReactModule {
  createElement(type: unknown, props?: unknown, ...children: unknown[]): unknown;
  Component: new (props: unknown) => { props: unknown; state: unknown };
}

let port: MessagePort | null = null;
// What happens before the port arrives (a blocked image while the HTML is parsed), sent then.
const early: Record<string, unknown>[] = [];

function send(event: Record<string, unknown>): void {
  if (port) port.postMessage(event);
  else if (early.length < 50) early.push(event);
}

function errorText(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

// A module specifier the bundler must not resolve: the import map of the document does.
const load = (specifier: string): Promise<unknown> => import(/* @vite-ignore */ specifier);

async function runReact(source: string): Promise<boolean> {
  const babel = (globalThis as { Babel?: BabelStandalone }).Babel;
  if (!babel) throw new Error('The JSX compiler did not load.');
  const compiled = babel.transform(source, {
    filename: 'App.tsx',
    sourceType: 'module',
    presets: [['react', { runtime: 'automatic' }], 'typescript'],
  }).code;
  if (!compiled) throw new Error('The code compiled to nothing.');
  const url = URL.createObjectURL(new Blob([compiled], { type: 'text/javascript' }));
  const app = (await load(url)) as { default?: unknown };
  if (typeof app.default !== 'function') {
    throw new Error('The code must export a component by default (export default function App).');
  }
  const React = (await load('react')) as ReactModule & { default?: ReactModule };
  const react = React.default ?? React;
  const client = (await load('react-dom/client')) as {
    createRoot: (element: Element) => { render: (node: unknown) => void };
  };
  const root = document.getElementById('root');
  if (!root) throw new Error('No root element.');
  let failed = false;
  class Boundary extends react.Component {
    override state: { failed: boolean } = { failed: false };
    static getDerivedStateFromError(): { failed: boolean } {
      return { failed: true };
    }
    componentDidCatch(error: unknown): void {
      failed = true;
      send({ type: 'error', message: errorText(error) });
    }
    render(): unknown {
      return this.state.failed ? null : (this.props as { children?: unknown }).children;
    }
  }
  client
    .createRoot(root)
    .render(react.createElement(Boundary, null, react.createElement(app.default)));
  // Two frames: React has committed and the browser has painted.
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  return !failed;
}

function append(parent: Element | null, element: Element): void {
  parent?.append(element);
}

function runPython(job: Job): Promise<boolean> {
  if (!job.pythonWorker || !job.pyodideUrl) return Promise.reject(new Error('No Python runtime.'));
  const worker = new Worker(
    URL.createObjectURL(new Blob([job.pythonWorker], { type: 'text/javascript' })),
  );
  const output = document.getElementById('console');
  const figures = document.getElementById('figures');
  return new Promise<boolean>((resolve) => {
    worker.onmessage = (message: MessageEvent<Record<string, unknown>>) => {
      const data = message.data;
      switch (data.type) {
        case 'status':
          send({ type: 'status', phase: data.phase });
          break;
        case 'stdout':
        case 'stderr': {
          const line = document.createElement('span');
          line.className = data.type;
          line.textContent = `${String(data.text)}\n`;
          append(output, line);
          break;
        }
        case 'image': {
          if (typeof data.png !== 'string' || !/^[A-Za-z0-9+/=]+$/.test(data.png)) break;
          const image = document.createElement('img');
          image.alt = 'Figura';
          image.src = `data:image/png;base64,${data.png}`;
          append(figures, image);
          break;
        }
        case 'error': {
          const line = document.createElement('span');
          line.className = 'stderr';
          line.textContent = `${String(data.message)}\n`;
          append(output, line);
          send({ type: 'error', message: data.message, line: data.line });
          worker.terminate();
          resolve(false);
          break;
        }
        case 'done':
          worker.terminate();
          resolve(true);
          break;
      }
    };
    worker.onerror = (event) => {
      send({ type: 'error', message: event.message || 'The Python worker failed.' });
      worker.terminate();
      resolve(false);
    };
    worker.postMessage({ source: job.source, indexURL: job.pyodideUrl });
  });
}

async function start(job: Job): Promise<void> {
  let ok = false;
  try {
    if (job.kind === 'html') ok = true;
    else if (job.kind === 'react') ok = await runReact(job.source);
    else if (job.kind === 'python') ok = await runPython(job);
  } catch (error) {
    send({ type: 'error', message: errorText(error) });
  }
  send({ type: 'done', ok });
}

addEventListener('message', (event: MessageEvent<unknown>) => {
  const handed = event.ports[0];
  if (port !== null || event.source !== parent || event.ports.length !== 1 || !handed) return;
  if ((event.data as { type?: unknown } | null)?.type !== 'mango-inner-init') return;
  port = handed;
  for (const event of early.splice(0)) handed.postMessage(event);
  port.onmessage = (message: MessageEvent<unknown>) => {
    void start(message.data as Job);
  };
});

addEventListener('error', (event: ErrorEvent) => {
  send({ type: 'error', message: event.message, line: event.lineno });
});

addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
  send({ type: 'error', message: errorText(event.reason) });
});

document.addEventListener('securitypolicyviolation', (event: SecurityPolicyViolationEvent) => {
  send({ type: 'csp-violation', directive: event.effectiveDirective });
});

document.addEventListener('DOMContentLoaded', () => {
  let last = -1;
  new ResizeObserver(() => {
    const px = Math.ceil(document.documentElement.scrollHeight);
    if (px !== last) {
      last = px;
      send({ type: 'height', px });
    }
  }).observe(document.documentElement);
});
