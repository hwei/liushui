import { describe, expect, it } from 'vitest';

import { SCHEMA_VERSION, DEFAULT_MAX_CONTENT_BYTES } from '../src/index.ts';
import {
  utf8ByteLength,
  validateAppendInput,
  validateMeta,
} from '../src/record.ts';

const base = {
  id: 'AAAABBBBCCCCDDDDEEEEFFFFGG',
  ts: '2026-10-08T07:47:08.479Z',
  author: 'will',
  kind: 'note',
  content: '测试内容',
};

describe('记录模型（task 2.1）', () => {
  it('schema_v 从 1 开始', () => {
    expect(SCHEMA_VERSION).toBe(1);
  });

  it('接受合法输入并归一 ts', () => {
    const result = validateAppendInput({ ...base, ts: '2026-10-08T15:47:08.479+08:00' });
    expect(result.ts).toBe('2026-10-08T07:47:08.479Z');
    expect(result.meta).toEqual({});
    expect(result.kind).toBe('note');
  });

  it('meta 缺省时为空对象', () => {
    expect(validateAppendInput(base).meta).toEqual({});
  });

  it('接受嵌套 meta（点号分层的物理形态）', () => {
    const meta = { git: { branch: 'main', dirty: false }, cwd: '/repo', tz: 'Asia/Shanghai' };
    expect(validateAppendInput({ ...base, meta }).meta).toEqual(meta);
  });

  it.each(['ts', 'author', 'kind', 'content', 'id'])('缺少 %s 被拒绝', (field) => {
    const input: Record<string, unknown> = { ...base };
    delete input[field];
    expect(() => validateAppendInput(input)).toThrowError(/缺少必填字段|必须是字符串/);
    try {
      validateAppendInput(input);
    } catch (error) {
      expect(error).toMatchObject({ code: expect.stringMatching(/missing_field|invalid_field/) });
      expect((error as { field?: string }).field).toBe(field);
    }
  });

  it('空的 ts/author/kind 被拒绝', () => {
    expect(() => validateAppendInput({ ...base, author: '' })).toThrowError(/不能为空/);
    expect(() => validateAppendInput({ ...base, kind: '' })).toThrowError(/不能为空/);
    expect(() => validateAppendInput({ ...base, ts: '' })).toThrowError(/不能为空/);
  });

  it('content 允许为空字符串（CLI 另行拒绝空内容）', () => {
    expect(validateAppendInput({ ...base, content: '' }).content).toBe('');
  });

  it('content 超限被拒绝，且按 UTF-8 字节计算', () => {
    const limit = 10;
    expect(() => validateAppendInput({ ...base, content: 'a'.repeat(11) }, { maxContentBytes: limit }))
      .toThrowError(/超过上限/);
    expect(validateAppendInput({ ...base, content: 'a'.repeat(10) }, { maxContentBytes: limit }).content)
      .toHaveLength(10);
    // 5 个中文字符 = 15 字节
    expect(utf8ByteLength('中文字符测')).toBe(15);
    expect(() => validateAppendInput({ ...base, content: '中文字符测' }, { maxContentBytes: 14 }))
      .toThrowError(/content_too_large|超过上限/);
    expect(DEFAULT_MAX_CONTENT_BYTES).toBeGreaterThan(0);
  });

  it('超限错误带 content_too_large 码与字段名', () => {
    try {
      validateAppendInput({ ...base, content: 'a'.repeat(5) }, { maxContentBytes: 4 });
      expect.unreachable('应当抛出');
    } catch (error) {
      expect(error).toMatchObject({ code: 'content_too_large', field: 'content' });
    }
  });

  it('非对象请求体被拒绝', () => {
    expect(() => validateAppendInput('nope')).toThrowError(/JSON 对象/);
    expect(() => validateAppendInput([])).toThrowError(/JSON 对象/);
    expect(() => validateAppendInput(null)).toThrowError(/JSON 对象/);
  });

  it.each([
    ['数组', []],
    ['字符串', 'meta'],
    ['null', null],
    ['数字', 1],
  ])('非法 meta（%s）被拒绝', (_label, meta) => {
    expect(() => validateAppendInput({ ...base, meta })).toThrowError(/键值对象/);
  });

  it('meta 值类型受限：拒绝 undefined、NaN、数组', () => {
    expect(() => validateMeta({ a: undefined })).toThrowError(/应省略该键/);
    expect(() => validateMeta({ a: Number.NaN })).toThrowError(/有限数值/);
    expect(() => validateMeta({ a: Number.POSITIVE_INFINITY })).toThrowError(/有限数值/);
    expect(() => validateMeta({ a: [1, 2] })).toThrowError(/不支持数组/);
    expect(() => validateMeta({ a: { b: [1] } })).toThrowError(/a\.b/);
  });

  it('meta 允许 JSON 原生值', () => {
    expect(validateMeta({ s: 'x', n: 1.5, b: true, nil: null, nested: { deep: 'y' } })).toEqual({
      s: 'x',
      n: 1.5,
      b: true,
      nil: null,
      nested: { deep: 'y' },
    });
  });
});
