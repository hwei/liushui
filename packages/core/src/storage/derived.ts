/**
 * 整体派生数据重建入口。
 *
 * 规范：openspec/changes/feedback-minimal/specs/memory-feedback/spec.md
 * 设计：openspec/changes/feedback-minimal/design.md
 *
 * 重要：新增派生数据必须在此登记！
 * 任何为 memories 建立的派生表（如全文索引、向量、图谱等），都必须在 rebuildDerived 中按序调用重建，
 * 以确保回归评估与维护流程能覆盖候选代码的全部派生规则。
 */

import type { Client } from '@libsql/client';

import { FTS_STATE_NAME, rebuildFts } from './fts.ts';

export interface DerivedBuildReport {
  name: string;
  version: number;
  rows: number;
}

/**
 * 依次重建全部派生数据并返回各自的版本与行数。
 * 注释写明：新增派生数据必须在此登记。
 */
export async function rebuildDerived(client: Client): Promise<DerivedBuildReport[]> {
  const reports: DerivedBuildReport[] = [];

  // 1. 全文检索索引 memories_fts
  const ftsResult = await rebuildFts(client);
  reports.push({
    name: FTS_STATE_NAME,
    version: ftsResult.version,
    rows: ftsResult.rows,
  });

  // 以后新增派生数据（如向量检索表）必须在此处按顺序登记调用

  return reports;
}
