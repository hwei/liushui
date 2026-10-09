import { describe, expect, it } from 'vitest';

import { ValidationError } from '../src/errors.ts';
import { FTS_SEGMENTER_V, expandFtsMacros, segment } from '../src/fts.ts';

/** 展开一个只含宏的语句，取出结果字面量的内容。 */
function expand(text: string): string {
  const out = expandFtsMacros(`fts('${text.replaceAll("'", "''")}')`);
  return out.slice(1, -1).replaceAll("''", "'");
}

function expectInvalid(statement: string, pattern?: RegExp): void {
  let caught: unknown;
  try {
    expandFtsMacros(statement);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ValidationError);
  const err = caught as ValidationError;
  expect(err.code).toBe('invalid_field');
  expect(err.field).toBe('sql');
  if (pattern) expect(err.message).toMatch(pattern);
}

describe('segment（task 2.1）', () => {
  it('版本号', () => {
    expect(FTS_SEGMENTER_V).toBe(1);
  });

  it('纯中文输出重叠二字单元', () => {
    expect(segment('渲染问题')).toBe('渲染 染问 问题');
  });

  it('中英混写：中日文两侧有分界', () => {
    expect(segment('iOS渲染问题')).toBe('iOS 渲染 染问 问题');
    expect(segment('渲染 shader').split(/\s+/)).toEqual(['渲染', 'shader']);
  });

  it('日文假名与长音符', () => {
    expect(segment('ログを確認した')).toBe('ログ グを を確 確認 認し した');
    expect(segment('サーバー')).toBe('サー ーバ バー');
  });

  it('标点切开 run', () => {
    expect(segment('渲染，问题')).toBe('渲染 ， 问题');
  });

  it('单字 run 不输出', () => {
    expect(segment('的')).toBe('');
    expect(segment('iOS的')).toBe('iOS');
    expect(segment('a的b')).toBe('a b');
  });

  it('空串与确定性', () => {
    expect(segment('')).toBe('');
    const text = '打包时 IL2CPP 报错，link.xml 缺条目';
    expect(segment(text)).toBe(segment(text));
  });
});

describe('expandFtsMacros（task 2.2）', () => {
  it('单个词展开为短语', () => {
    expect(expandFtsMacros("SELECT 1 WHERE x MATCH fts('渲染')")).toBe(
      `SELECT 1 WHERE x MATCH '("渲染")'`,
    );
    expect(expand('渲染问题')).toBe('("渲染 染问 问题")');
  });

  it('多个词表示同时出现', () => {
    expect(expand('打包 报错')).toBe('("打包" "报错")');
  });

  it('OR 表示任一出现，且 AND 优先', () => {
    expect(expand('阴影 OR 数据库')).toBe('("阴影") OR ("数据 据库")');
    expect(expand('打包 报错 OR 阴影')).toBe('("打包" "报错") OR ("阴影")');
  });

  it('引号与运算符被当作普通字符', () => {
    expect(expand('"NEAR" link.xml*')).toBe('("""NEAR""" "link.xml*")');
  });

  it('小写 or 是普通词', () => {
    expect(expand('a or b')).toBe('("a" "or" "b")');
  });

  it('文本里的单引号被正确转义', () => {
    expect(expandFtsMacros("fts('don''t')")).toBe(`'("don''t")'`);
  });

  it('宏名不区分大小写，括号内可有空白', () => {
    expect(expandFtsMacros("FTS (  '渲染' )")).toBe(`'("渲染")'`);
  });

  it('同一语句里多个宏都展开，其余文本与 ? 参数不变', () => {
    const out = expandFtsMacros("SELECT ? WHERE a MATCH fts('渲染') OR b MATCH fts('阴影') AND c = ?");
    expect(out).toBe(`SELECT ? WHERE a MATCH '("渲染")' OR b MATCH '("阴影")' AND c = ?`);
    expect(out.match(/\?/g)).toHaveLength(2);
  });

  it('字符串和注释里的 fts( 不展开', () => {
    const s1 = "SELECT 'fts(''x'')' AS s -- fts('y')";
    expect(expandFtsMacros(s1)).toBe(s1);
    const s2 = "SELECT 1 /* fts('z') */";
    expect(expandFtsMacros(s2)).toBe(s2);
  });

  it('不含宏的语句原样返回；memories_fts 表名不是宏', () => {
    const s = 'SELECT * FROM memories_fts WHERE memories_fts MATCH ?';
    expect(expandFtsMacros(s)).toBe(s);
  });

  it('参数不是单个字符串字面量时报错', () => {
    expectInvalid('SELECT fts(?)', /字符串字面量/);
    expectInvalid('SELECT fts(body)');
    expectInvalid("SELECT fts('a', 'b')");
    expectInvalid("SELECT fts('a' || 'b')");
    expectInvalid("SELECT fts('a'");
    expectInvalid('SELECT fts()');
  });

  it('空文本、只有 OR 报错', () => {
    expectInvalid("SELECT fts('')", /不能为空/);
    expectInvalid("SELECT fts('   ')", /不能为空/);
    expectInvalid("SELECT fts('OR')", /OR/);
  });

  it('开头、结尾、连续的 OR 报错', () => {
    expectInvalid("SELECT fts('OR 渲染')", /OR/);
    expectInvalid("SELECT fts('渲染 OR')", /OR/);
    expectInvalid("SELECT fts('渲染 OR OR 阴影')", /OR/);
  });

  it('单字与夹带单字的词报错并提示 LIKE', () => {
    expectInvalid("SELECT fts('渲')", /LIKE/);
    expectInvalid("SELECT fts('iOS的')", /LIKE/);
    expectInvalid("SELECT fts('渲染 的')", /LIKE/);
  });

  it('纯标点的词报错', () => {
    expectInvalid("SELECT fts('...')", /没有可检索/);
    expectInvalid("SELECT fts('渲染 ,')", /没有可检索/);
  });
});
