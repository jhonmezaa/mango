import type { zChatTableOutSchema } from '@mango/api-client/schemas';
import { memo, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { z } from 'zod';

import type { CodeFile } from '../../api/codeSchemas';
import { formatCell } from './chartSpec';
import { OutputNotice } from './ChatChart';
import { useChatOutput, useFileView } from './chatFiles';
import { FileCard } from './FileCard';

type ChatTableOut = z.output<typeof zChatTableOutSchema>;

/** Design round 40 `CR_TABLE_CAP`: the rows a table shows; the CSV has them all. */
export const TABLE_CAP = 200;
/** Counts of rows in the browser's locale («1.248 filas»). */
const NUMBER = new Intl.NumberFormat();

/** A column whose every value is a number: aligned to the right, in mono (design round 40). */
function numericColumns(table: ChatTableOut): boolean[] {
  return table.columns.map((_, index) => {
    let seen = false;
    for (const row of table.rows) {
      const value = row[index];
      if (value === null || value === undefined) continue;
      if (typeof value !== 'number') return false;
      seen = true;
    }
    return seen;
  });
}

/**
 * Design round 40 `DataTable`: its name, «{n} filas · {n} columnas», a fixed header and a
 * scroll of 300 px, at most 200 rows («Se muestran 200 de {n} filas…») and the card of its CSV
 * at the foot. Every cell is text from the sandbox, rendered escaped.
 */
export const TableCard = memo(function TableCard({
  table,
  csv,
}: {
  table: ChatTableOut;
  csv?: CodeFile | undefined;
}) {
  const { t } = useTranslation();
  const numeric = useMemo(() => numericColumns(table), [table]);
  const shown = table.rows.slice(0, TABLE_CAP);
  return (
    <div className="cr-table">
      <div className="cr-table-h">
        <span className="cr-chart-t">{table.name}</span>
        <span className="mono">
          {t('chat.table.rows', {
            count: table.total_rows,
            n: NUMBER.format(table.total_rows),
          })}{' '}
          · {t('chat.table.columns', { count: table.columns.length })}
        </span>
      </div>
      {/* Scrolls with the keyboard too (design: tabIndex 0, a named region). */}
      <div className="cr-table-s" tabIndex={0} role="region" aria-label={table.name}>
        <table>
          <thead>
            <tr>
              {table.columns.map((column, index) => (
                <th key={`${column}-${String(index)}`} className={numeric[index] ? 'num' : ''}>
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((row, r) => (
              <tr key={r}>
                {table.columns.map((column, c) => (
                  <td key={`${column}-${String(c)}`} className={numeric[c] ? 'num mono' : ''}>
                    {formatCell(row[c])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {table.total_rows > shown.length ? (
        <div className="cr-table-f">
          {t('chat.table.capped', {
            shown: NUMBER.format(shown.length),
            total: NUMBER.format(table.total_rows),
          })}
        </div>
      ) : null}
      {csv ? <FileCard file={csv} compact /> : null}
    </div>
  );
});

/**
 * A table a cell wrote (`<name>.table.json`), read from the API once its scan let it be read;
 * `csv` is the file of the same cell with all its rows («la tarjeta del CSV al pie»).
 */
export const ChatTableFile = memo(function ChatTableFile({
  file,
  csv,
}: {
  file: CodeFile;
  csv?: CodeFile | undefined;
}) {
  const { t } = useTranslation();
  const scan = useFileView(file.file_id, file.gone ?? false);
  const [attempt, setAttempt] = useState(0);
  const view = useChatOutput(file.file_id, scan === 'ready', attempt);
  if (scan === 'blocked' || scan === 'gone') {
    return csv ? <FileCard file={csv} /> : <FileCard file={file} />;
  }
  if (view.kind === 'ready' && view.output.table) {
    return <TableCard table={view.output.table} csv={csv} />;
  }
  if (view.kind === 'loading') {
    return (
      <div className="cr-table">
        <div className="cr-chart-load" role="status" aria-label={t('chat.table.loadingLabel')}>
          <span className="spinner" aria-hidden="true" />
        </div>
      </div>
    );
  }
  const notice =
    view.kind === 'withheld' ? (
      <OutputNotice tone="lock">{t('chat.table.withheld')}</OutputNotice>
    ) : view.kind === 'error' ? (
      <OutputNotice
        tone="warn"
        retry={t('chat.table.retry')}
        onRetry={() => {
          setAttempt((n) => n + 1);
        }}
      >
        {t('chat.table.error')}
      </OutputNotice>
    ) : (
      <OutputNotice tone="warn">{t('chat.table.invalid')}</OutputNotice>
    );
  return (
    <div className="cr-table">
      {notice}
      {csv ? <FileCard file={csv} compact /> : null}
    </div>
  );
});
