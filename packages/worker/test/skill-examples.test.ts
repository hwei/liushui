import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PERSONAL_TOKEN, callAppend, callSql, createTestContext, makeAppendBody, type TestContext } from './helpers.ts';

const SKILL = fileURLToPath(new URL('../../../skills/liushui/SKILL.md', import.meta.url));

/** 取出 SKILL.md 里所有含 fts( 的 SQL 示例（```sql 代码块，以空行分段后的各条语句）。 */
function ftsExamples(): string[] {
  const text = readFileSync(SKILL, 'utf8').replace(/\r\n/g, '\n');
  const blocks = [...text.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1]!);
  return blocks
    .flatMap((block) => block.split(/\n\s*\n/))
    .map((chunk) =>
      chunk
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n')
        .trim(),
    )
    .filter((sql) => /\bfts\s*\(/i.test(sql));
}

describe('skill 中的 FTS 示例', () => {
  let ctx: TestContext;
  beforeEach(async () => {
    ctx = await createTestContext();
    await callAppend(ctx, await makeAppendBody({ content: 'iOS 渲染问题，打包 报错' }), PERSONAL_TOKEN);
  });
  afterEach(async () => {
    await ctx.cleanup();
  });

  it('至少包含若干条示例', () => {
    expect(ftsExamples().length).toBeGreaterThanOrEqual(3);
  });

  it('除“被拒绝的单字示例”外，每条都能成功执行', async () => {
    for (const sql of ftsExamples()) {
      if (/fts\('(渲|iOS的)'\)/.test(sql)) continue;
      const { status, body } = await callSql(ctx, { sql }, PERSONAL_TOKEN);
      expect(status, `${sql}\n${JSON.stringify(body)}`).toBe(200);
    }
  });

  it('单字示例返回带 LIKE 提示的错误', async () => {
    const { status, body } = await callSql(
      ctx,
      { sql: "SELECT id FROM memories_fts WHERE memories_fts MATCH fts('渲')" },
      PERSONAL_TOKEN,
    );
    expect(status).toBe(400);
    expect(body.error?.message).toMatch(/LIKE/);
  });
});
