import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type {
  FullResult,
  Reporter,
  TestCase,
  TestError,
  TestResult,
} from '@playwright/test/reporter';

import { loadConfig, redactorOf, EFFECTS, ROLES, type InstallConfig } from './config.ts';
import { maskUrl, type Redactor } from './redact.ts';

// The only reporter of the suite. Everything a run prints or writes goes through `redact`, so
// neither the console nor the report carries an address, an id or a secret of the installation.
// The report (Spanish, like the rest of the documentation) is written outside the repository.

interface Line {
  title: string;
  file: string;
  status: TestResult['status'];
  seconds: number;
  errors: string[];
  skipped: string[];
  leaves: string[];
  notes: string[];
}

const MARK: Record<TestResult['status'], string> = {
  passed: 'ok  ',
  failed: 'FAIL',
  timedOut: 'FAIL',
  interrupted: 'FAIL',
  skipped: 'skip',
};

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

export function describeError(error: TestError, redact: Redactor): string {
  const text = (error.message ?? error.value ?? 'error').replace(ANSI, '');
  return redact(text).split('\n').slice(0, 14).join('\n');
}

/** The report of one run, in Markdown. Pure: the caller has already masked every text. */
export function renderReport(input: {
  url: string;
  startedAt: string;
  seconds: number;
  outcome: string;
  release: string | null;
  roles: Record<string, boolean>;
  effects: Record<string, boolean>;
  lines: readonly Line[];
}): string {
  const count = (status: string) => input.lines.filter((line) => line.status === status).length;
  const failed = input.lines.filter((line) => !['passed', 'skipped'].includes(line.status));
  const skipped = input.lines.filter((line) => line.status === 'skipped');
  const out: string[] = [
    '# Comprobación de una instalación de Mango',
    '',
    `- **Instalación:** ${input.url}`,
    `- **Release que muestra:** ${input.release ?? 'no se leyó (el recorrido de Instalación no corrió o falló)'}`,
    `- **Inicio:** ${input.startedAt} · **Duración:** ${input.seconds.toFixed(0)} s`,
    `- **Resultado:** ${input.outcome} · ${count('passed')} pasaron, ${failed.length} fallaron, ${skipped.length} se saltaron`,
    `- **Papeles con usuario:** ${Object.entries(input.roles)
      .map(([role, has]) => `${role} ${has ? 'sí' : 'no'}`)
      .join(', ')}`,
    `- **Recorridos con efecto pedidos:** ${Object.entries(input.effects)
      .map(([effect, on]) => `${effect} ${on ? 'sí' : 'no'}`)
      .join(', ')}`,
    '',
    '## Qué pasó',
    '',
    '| Resultado | Recorrido | Archivo | Tiempo |',
    '|---|---|---|---|',
    ...input.lines.map(
      (line) =>
        `| ${line.status === 'passed' ? 'pasó' : line.status === 'skipped' ? 'se saltó' : '**falló**'} | ${line.title.replaceAll('|', '\\|')} | \`${line.file}\` | ${line.seconds.toFixed(1)} s |`,
    ),
    '',
  ];
  if (failed.length > 0) {
    out.push('## Fallos', '');
    for (const line of failed) {
      out.push(`### ${line.title}`, '', '```', ...line.errors, '```', '');
    }
  }
  out.push('## Qué se saltó y por qué', '');
  if (skipped.length === 0) out.push('Nada.', '');
  else {
    for (const line of skipped) {
      out.push(`- ${line.title}: ${line.skipped.join('; ') || 'sin motivo declarado'}`);
    }
    out.push('');
  }
  const left = input.lines.flatMap((line) =>
    line.leaves.map((text) => `- ${text} _(${line.title})_`),
  );
  out.push('## Qué quedó en la instalación', '');
  out.push(
    ...(left.length > 0 ? left : ['Solo los eventos de Auditoría de cada ingreso y lectura.']),
  );
  out.push('');
  const notes = input.lines.flatMap((line) => line.notes.map((text) => `- ${text}`));
  if (notes.length > 0) out.push('## Notas', '', ...notes, '');
  return out.join('\n');
}

export default class InstallReporter implements Reporter {
  #config: InstallConfig | undefined;
  #redact: Redactor = (text) => text;
  #broken: string | undefined;
  readonly #lines: Line[] = [];
  readonly #startedAt = new Date();
  readonly #loose: string[] = [];

  #print(text: string): void {
    process.stdout.write(`${this.#redact(text)}\n`);
  }

  onBegin(): void {
    try {
      this.#config = loadConfig();
      this.#redact = redactorOf(this.#config);
      this.#print(`install-check · ${maskUrl(this.#config.baseUrl)}`);
    } catch (error) {
      this.#broken = error instanceof Error ? error.message : 'configuration error';
    }
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    // With retries off there is one result per test; a retry would replace the earlier line.
    const of = (type: string) =>
      [...test.annotations, ...result.annotations]
        .filter((annotation) => annotation.type === type && annotation.description)
        .map((annotation) => this.#redact(annotation.description ?? ''));
    const line: Line = {
      title: this.#redact(test.titlePath().slice(3).join(' › ')),
      file: test.location.file.split('/').slice(-1)[0] ?? '',
      status: result.status,
      seconds: Math.round(result.duration / 100) / 10,
      errors: result.errors.map((error) => describeError(error, this.#redact)),
      skipped: [...new Set(of('skip'))],
      leaves: [...new Set(of('leaves'))],
      notes: [...new Set(of('note'))],
    };
    const at = this.#lines.findIndex((l) => l.title === line.title && l.file === line.file);
    if (at >= 0) this.#lines[at] = line;
    else this.#lines.push(line);
    const why = line.status === 'skipped' && line.skipped[0] ? ` — ${line.skipped[0]}` : '';
    this.#print(`${MARK[line.status]} ${line.title} (${line.seconds.toFixed(1)} s)${why}`);
    for (const error of line.errors) this.#print(error.replace(/^/gm, '       '));
  }

  onError(error: TestError): void {
    const text = describeError(error, this.#redact);
    this.#loose.push(text);
    this.#print(`FAIL ${text}`);
  }

  // What a test or the browser writes is not echoed: only this reporter prints.
  onStdOut(): void {
    return;
  }

  onStdErr(): void {
    return;
  }

  onEnd(result: FullResult): void {
    const config = this.#config;
    if (!config) {
      process.stdout.write(`install-check: ${this.#broken ?? 'no configuration'}\n`);
      return;
    }
    const release =
      this.#lines
        .flatMap((line) => line.notes)
        .map((text) => /^release: (.+)$/.exec(text)?.[1])
        .find((value) => value !== undefined) ?? null;
    const lines = this.#loose.length
      ? [
          ...this.#lines,
          {
            title: 'fuera de un recorrido',
            file: '-',
            status: 'failed' as const,
            seconds: 0,
            errors: this.#loose,
            skipped: [],
            leaves: [],
            notes: [],
          },
        ]
      : this.#lines;
    const summary = {
      url: maskUrl(config.baseUrl),
      startedAt: this.#startedAt.toISOString(),
      seconds: Math.round(result.duration / 100) / 10,
      outcome: result.status === 'passed' ? 'pasó' : `no pasó (${result.status})`,
      release,
      roles: Object.fromEntries(ROLES.map((role) => [role, config.users[role] !== undefined])),
      effects: Object.fromEntries(EFFECTS.map((effect) => [effect, config.effects.has(effect)])),
      lines,
    };
    mkdirSync(config.runDir, { recursive: true });
    writeFileSync(join(config.runDir, 'informe.md'), this.#redact(renderReport(summary)));
    writeFileSync(
      join(config.runDir, 'resultado.json'),
      this.#redact(JSON.stringify(summary, null, 1)),
    );
    const count = (status: string) => lines.filter((line) => line.status === status).length;
    this.#print(
      `${summary.outcome} · ${count('passed')} pasaron, ${lines.length - count('passed') - count('skipped')} fallaron, ${count('skipped')} se saltaron · ${summary.seconds.toFixed(0)} s`,
    );
    // The path of the report is local to who runs the suite; it is printed as it is.
    process.stdout.write(`informe: ${join(config.runDir, 'informe.md')}\n`);
  }
}
