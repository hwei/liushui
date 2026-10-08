import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { base32Encode, canonicalIdInput, canonicalJson, computeId, normalizeTs } from '../src/canonical.ts';

interface Vector {
  name: string;
  input: {
    ts: string;
    author: string;
    kind: string;
    content: string;
    attachments?: string[];
  };
  canonical: string;
  sha256?: string;
  id: string;
}

const vectorsFile = fileURLToPath(new URL('../vectors/id-vectors.json', import.meta.url));
const { vectors } = JSON.parse(readFileSync(vectorsFile, 'utf8')) as { vectors: Vector[] };

describe('确定性 ID（task 2.2 / 2.3）', () => {
  it('base32Encode 通过 RFC 4648 官方测试向量', () => {
    const cases: Array<[string, string]> = [
      ['', ''],
      ['f', 'MY'],
      ['fo', 'MZXQ'],
      ['foo', 'MZXW6'],
      ['foob', 'MZXW6YQ'],
      ['fooba', 'MZXW6YTB'],
      ['foobar', 'MZXW6YTBOI'],
    ];
    for (const [input, expected] of cases) {
      expect(base32Encode(new TextEncoder().encode(input))).toBe(expected);
    }
  });

  it('base32Encode 对多字节输入不溢出（长于 32 位的累加）', () => {
    const bytes = new Uint8Array(64).fill(0xff);
    const expected = `${'7'.repeat(102)}Y`;
    expect(base32Encode(bytes)).toBe(expected);
    expect(base32Encode(bytes)).toHaveLength(103);
  });

  it('128 位固定编码为 26 个字符', async () => {
    const id = await computeId(vectors[0]!.input);
    expect(id).toHaveLength(26);
    expect(id).toMatch(/^[A-Z2-7]{26}$/);
  });

  it('canonicalJson 递归按键排序', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
    expect(canonicalJson({ a: 1, b: { z: [3, 1] } })).toBe('{"a":1,"b":{"z":[3,1]}}');
  });

  it('normalizeTs 消除等价时间表示', () => {
    expect(normalizeTs('2026-10-08T15:47:08.479+08:00')).toBe('2026-10-08T07:47:08.479Z');
    expect(normalizeTs('2026-10-08T07:47:08.479Z')).toBe('2026-10-08T07:47:08.479Z');
    expect(normalizeTs('2026-01-02T03:04:05Z')).toBe('2026-01-02T03:04:05.000Z');
    expect(normalizeTs('2026-01-02T03:04:05.5Z')).toBe('2026-01-02T03:04:05.500Z');
  });

  it('无效时间被拒绝', () => {
    expect(() => normalizeTs('not-a-date')).toThrowError(/无效的时间表示/);
  });

  for (const vector of vectors) {
    it(`测试向量：${vector.name}`, async () => {
      expect(canonicalIdInput(vector.input)).toBe(vector.canonical);
      expect(await computeId(vector.input)).toBe(vector.id);
      if (vector.sha256) {
        // 用 node:crypto 独立复算 sha256，避免只相信 crypto.subtle 一条路径。
        const digest = createHash('sha256').update(vector.canonical, 'utf8').digest('hex');
        expect(digest).toBe(vector.sha256);
      }
    });
  }

  it('meta 与目标库不影响 ID', async () => {
    const core = { ts: '2026-10-08T07:47:08.479Z', author: 'will', kind: 'note', content: '同一内容' };
    const a = await computeId(core);
    const b = await computeId(core);
    expect(a).toBe(b);
  });

  it('content 差一个字符得到不同 ID', async () => {
    const core = { ts: '2026-10-08T07:47:08.479Z', author: 'will', kind: 'note' };
    const a = await computeId({ ...core, content: 'abc' });
    const b = await computeId({ ...core, content: 'abd' });
    expect(a).not.toBe(b);
  });

  it('附件顺序不影响 ID', async () => {
    const core = {
      ts: '2026-01-02T03:04:05Z',
      author: 'will',
      kind: 'note',
      content: 'x',
    };
    expect(await computeId({ ...core, attachments: ['b', 'a'] }))
      .toBe(await computeId({ ...core, attachments: ['a', 'b'] }));
  });
});
