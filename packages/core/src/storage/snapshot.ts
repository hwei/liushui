/**
 * 本地回归快照的读写。
 *
 * 规范：openspec/changes/feedback-minimal/specs/memory-feedback/spec.md
 * 设计：openspec/changes/feedback-minimal/design.md (Decision 4)
 *
 * 快照格式为 JSONL：
 * 第一行是头部：
 *   {"liushui_snapshot":1,"taken_at":"...","rows":N,"schema_versions":[...]}
 * 之后每行一条 memories 记录（8 列原样存储：id, ts, author, kind, content, meta, received_at, schema_v）。
 */

import { readFileSync } from 'node:fs';
import type { Client } from '@libsql/client';

import { ValidationError } from '../errors.ts';
import { appliedVersions } from './migrate.ts';

export const CURRENT_SNAPSHOT_VERSION = 1;
const SNAPSHOT_PAGE_SIZE = 500;

export interface SnapshotHeader {
  liushui_snapshot: number;
  taken_at: string;
  rows: number;
  schema_versions: number[];
}

/** 快照行记录：8 列原值。meta 保持原始 JSON 字符串。 */
export interface SnapshotRow {
  id: string;
  ts: string;
  author: string;
  kind: string;
  content: string;
  meta: string;
  received_at: string;
  schema_v: number;
}

export interface SnapshotFile {
  header: SnapshotHeader;
  rows: SnapshotRow[];
}

/** 写入接口，可以写入一行文本（不含换行）。 */
export interface SnapshotWriter {
  writeLine(line: string): Promise<void> | void;
}

/**
 * 按 id 分页读取 memories 表全部 8 列并导出为 JSONL 快照。
 * 首行写头部，之后逐行写记录。
 */
export async function exportSnapshot(
  client: Client,
  writer: SnapshotWriter,
  options: { now?: () => Date } = {},
): Promise<SnapshotHeader> {
  const versions = await appliedVersions(client);
  const countResult = await client.execute('SELECT COUNT(*) AS n FROM memories');
  const totalRows = Number(countResult.rows[0]?.['n'] ?? 0);
  const takenAt = (options.now ?? (() => new Date()))().toISOString();

  const header: SnapshotHeader = {
    liushui_snapshot: CURRENT_SNAPSHOT_VERSION,
    taken_at: takenAt,
    rows: totalRows,
    schema_versions: versions,
  };

  await writer.writeLine(JSON.stringify(header));

  let afterId = '';
  let writtenRows = 0;

  for (;;) {
    const page = await client.execute({
      sql: `SELECT id, ts, author, kind, content, meta, received_at, schema_v
            FROM memories
            WHERE id > ?
            ORDER BY id
            LIMIT ?`,
      args: [afterId, SNAPSHOT_PAGE_SIZE],
    });

    if (page.rows.length === 0) {
      break;
    }

    for (const r of page.rows) {
      const row: SnapshotRow = {
        id: String(r['id']),
        ts: String(r['ts']),
        author: String(r['author']),
        kind: String(r['kind']),
        content: String(r['content']),
        meta: String(r['meta']),
        received_at: String(r['received_at']),
        schema_v: Number(r['schema_v']),
      };
      await writer.writeLine(JSON.stringify(row));
      writtenRows += 1;
      afterId = row.id;
    }
  }

  if (writtenRows !== totalRows) {
    throw new Error(`快照导出异常：预期 ${totalRows} 行，实际写入 ${writtenRows} 行`);
  }

  return header;
}

const REQUIRED_ROW_COLUMNS = [
  'id',
  'ts',
  'author',
  'kind',
  'content',
  'meta',
  'received_at',
  'schema_v',
] as const;

/**
 * 读取快照文件：校验首行头部、校验行数一致性、校验各行 8 列字段完整性。
 * 不一致或截断报错。
 */
export function readSnapshot(filePath: string): SnapshotFile {
  const content = readFileSync(filePath, 'utf8');
  const lines = content.split('\n').filter((l) => l.trim().length > 0);

  if (lines.length === 0) {
    throw new ValidationError('invalid_request', '快照文件为空');
  }

  let headerRaw: unknown;
  try {
    headerRaw = JSON.parse(lines[0]!);
  } catch (err) {
    throw new ValidationError('invalid_request', `快照头部不是合法 JSON：${String(err)}`);
  }

  if (
    typeof headerRaw !== 'object' ||
    headerRaw === null ||
    !('liushui_snapshot' in headerRaw) ||
    !('rows' in headerRaw) ||
    !('taken_at' in headerRaw) ||
    !('schema_versions' in headerRaw)
  ) {
    throw new ValidationError('invalid_request', '快照头部字段不完整');
  }

  const header = headerRaw as SnapshotHeader;
  if (header.liushui_snapshot !== CURRENT_SNAPSHOT_VERSION) {
    throw new ValidationError(
      'invalid_request',
      `不支持的快照版本：${header.liushui_snapshot}，当前为 ${CURRENT_SNAPSHOT_VERSION}`,
    );
  }

  const expectedRows = header.rows;
  const actualDataLines = lines.length - 1;

  if (actualDataLines !== expectedRows) {
    throw new ValidationError(
      'invalid_request',
      `快照文件行数不一致（文件可能被截断）：头部声明 ${expectedRows} 行，实际读取到 ${actualDataLines} 行`,
    );
  }

  const rows: SnapshotRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const lineIndex = i;
    let rowRaw: unknown;
    try {
      rowRaw = JSON.parse(lines[i]!);
    } catch (err) {
      throw new ValidationError(
        'invalid_request',
        `快照第 ${lineIndex + 1} 行不是合法 JSON：${String(err)}`,
      );
    }
    if (typeof rowRaw !== 'object' || rowRaw === null) {
      throw new ValidationError('invalid_request', `快照第 ${lineIndex + 1} 行不是对象`);
    }

    const rec = rowRaw as Record<string, unknown>;
    for (const col of REQUIRED_ROW_COLUMNS) {
      if (!(col in rec) || rec[col] === undefined || rec[col] === null) {
        throw new ValidationError('invalid_request', `快照第 ${lineIndex + 1} 行缺少字段：${col}`);
      }
    }

    rows.push({
      id: String(rec['id']),
      ts: String(rec['ts']),
      author: String(rec['author']),
      kind: String(rec['kind']),
      content: String(rec['content']),
      meta: String(rec['meta']),
      received_at: String(rec['received_at']),
      schema_v: Number(rec['schema_v']),
    });
  }

  return { header, rows };
}
