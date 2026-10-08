/**
 * `liushui sql` 的结果格式化：默认 TSV，`--json` 为 JSONL。
 *
 * - 单元格内的制表符、换行、回车与反斜杠转义，保证一行对应一条记录；
 * - NULL 输出为 `\N`（COPY 惯例，可与空串区分）；
 * - `--max-width` 按码点截断并加省略号，返回被截断的单元格个数。
 */

/** 查询响应（Worker `/sql` 的 200 响应体）。 */
export interface QueryResponse {
  vault: string;
  columns: string[];
  rows: Array<Array<string | number | null>>;
  truncated: { rows: boolean; cells: number };
  stats?: { rows_read?: number; duration_ms?: number };
}

export interface FormattedOutput {
  text: string;
  /** 仅由 `--max-width` 造成的截断个数。 */
  truncatedCells: number;
}

const TSV_ESCAPES: Record<string, string> = {
  '\\': '\\\\',
  '\t': '\\t',
  '\n': '\\n',
  '\r': '\\r',
};

function escapeTsv(value: string): string {
  return value.replace(/[\\\t\n\r]/g, (char) => TSV_ESCAPES[char] ?? char);
}

function truncateWidth(value: string, maxWidth: number): { text: string; truncated: boolean } {
  const codePoints = Array.from(value);
  if (codePoints.length <= maxWidth) return { text: value, truncated: false };
  return { text: `${codePoints.slice(0, maxWidth - 1).join('')}…`, truncated: true };
}

/** 默认 TSV：一行表头加若干行数据；空结果只输出表头。 */
export function formatTsv(
  columns: readonly string[],
  rows: ReadonlyArray<ReadonlyArray<string | number | null>>,
  maxWidth: number,
): FormattedOutput {
  let truncatedCells = 0;
  const lines: string[] = [columns.map(escapeTsv).join('\t')];
  for (const row of rows) {
    const cells = columns.map((_name, index) => {
      const value = row[index];
      if (value === null || value === undefined) return '\\N';
      const text = typeof value === 'number' ? String(value) : value;
      const truncated = truncateWidth(text, maxWidth);
      if (truncated.truncated) truncatedCells += 1;
      return escapeTsv(truncated.text);
    });
    lines.push(cells.join('\t'));
  }
  return { text: `${lines.join('\n')}\n`, truncatedCells };
}

/** JSONL：每行一个以列名为键的对象；空结果不输出任何行。 */
export function formatJsonl(
  columns: readonly string[],
  rows: ReadonlyArray<ReadonlyArray<string | number | null>>,
  maxWidth: number,
): FormattedOutput {
  let truncatedCells = 0;
  const lines = rows.map((row) => {
    const record: Record<string, string | number | null> = {};
    columns.forEach((name, index) => {
      const value = row[index];
      if (value === null || value === undefined) {
        record[name] = null;
        return;
      }
      if (typeof value === 'number') {
        record[name] = value;
        return;
      }
      const truncated = truncateWidth(value, maxWidth);
      if (truncated.truncated) truncatedCells += 1;
      record[name] = truncated.text;
    });
    return JSON.stringify(record);
  });
  return { text: lines.length > 0 ? `${lines.join('\n')}\n` : '', truncatedCells };
}
