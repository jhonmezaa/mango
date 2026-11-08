/**
 * The Python worker of an inner frame (D124 (4)): Pyodide from the mirror of the release, with
 * only the packages the mirror has (numpy, pandas, matplotlib and their dependencies). No
 * `micropip` and no PyPI: the policy of the frame only reaches the mirror (TM-UI4, TM-UI8).
 * matplotlib draws with AGG and each open figure comes back as a PNG. The runner ends the run by
 * destroying the frame, which ends this worker (no `SharedArrayBuffer`, no interrupts, TM-UI9).
 */

import { cleanTraceback, errorLine } from './python-errors';

interface PyProxy {
  toJs(): unknown;
  destroy(): void;
}

interface Pyodide {
  runPython(code: string): unknown;
  runPythonAsync(code: string): Promise<unknown>;
  loadPackagesFromImports(
    code: string,
    options: {
      messageCallback: (message: string) => void;
      errorCallback: (message: string) => void;
    },
  ): Promise<unknown>;
  setStdout(options: { batched: (text: string) => void }): void;
  setStderr(options: { batched: (text: string) => void }): void;
}

declare function importScripts(...urls: string[]): void;
declare function loadPyodide(options: { indexURL: string; fullStdLib?: boolean }): Promise<Pyodide>;

const FIGURES = `
import base64, io, sys
_figures = []
if "matplotlib.pyplot" in sys.modules:
    import matplotlib.pyplot as _plt
    for _number in _plt.get_fignums():
        _buffer = io.BytesIO()
        _plt.figure(_number).savefig(_buffer, format="png", bbox_inches="tight")
        _figures.append(base64.b64encode(_buffer.getvalue()).decode("ascii"))
    _plt.close("all")
_figures
`;

const post = (message: Record<string, unknown>): void => {
  self.postMessage(message);
};

let pyodide: Promise<Pyodide> | null = null;

self.onmessage = async (event: MessageEvent<{ source: string; indexURL: string }>) => {
  const { source, indexURL } = event.data;
  try {
    post({ type: 'status', phase: 'initializing' });
    if (pyodide === null) {
      importScripts(`${indexURL}pyodide.js`);
      pyodide = loadPyodide({ indexURL });
    }
    const py = await pyodide;
    py.setStdout({
      batched: (text) => {
        post({ type: 'stdout', text });
      },
    });
    py.setStderr({
      batched: (text) => {
        post({ type: 'stderr', text });
      },
    });
    // Before anything imports matplotlib: the browser backend needs a DOM a worker lacks.
    py.runPython('import os; os.environ["MPLBACKEND"] = "AGG"');
    post({ type: 'status', phase: 'loading-packages' });
    await py.loadPackagesFromImports(source, {
      messageCallback: () => undefined,
      errorCallback: (text) => {
        post({ type: 'stderr', text });
      },
    });
    post({ type: 'status', phase: 'running' });
    await py.runPythonAsync(source);
    const figures = py.runPython(FIGURES) as PyProxy | undefined;
    const pngs = figures?.toJs();
    figures?.destroy();
    for (const png of Array.isArray(pngs) ? pngs : []) {
      if (typeof png === 'string') post({ type: 'image', png });
    }
    post({ type: 'done' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const line = errorLine(message);
    post({
      type: 'error',
      message: cleanTraceback(message),
      ...(line === undefined ? {} : { line }),
    });
  }
};
