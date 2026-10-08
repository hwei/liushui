import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createClient, type Client } from '@libsql/client';

/** 一个临时的本地 libSQL 文件库，用于不依赖云端的存储测试。 */
export interface TempDb {
  client: Client;
  file: string;
  cleanup(): Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Windows 上 libSQL 的文件句柄释放略有延迟，直接递归删除会偶发 EPERM。
 * 这里重试若干次；仍失败则放弃清理（临时目录由系统回收），不影响测试结论。
 */
async function removeDirBestEffort(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      await sleep(50);
    }
  }
}

/** 在系统临时目录里创建一个空的 libSQL 文件库。 */
export function createTempDb(): TempDb {
  const dir = mkdtempSync(join(tmpdir(), 'liushui-core-'));
  const file = join(dir, 'mem.db');
  const url = `file:${file.replaceAll('\\', '/')}`;
  const client = createClient({ url });
  return {
    client,
    file,
    async cleanup(): Promise<void> {
      client.close();
      await sleep(20);
      await removeDirBestEffort(dir);
    },
  };
}
