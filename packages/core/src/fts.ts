/**
 * 全文检索的切分与查询宏展开（纯函数，不接触数据库）。
 *
 * 索引端（追加、重建）与查询端（`fts('…')` 宏）共用同一套 {@link segment}，
 * 所以对任何输入两边的切分都一致。规则变化必须升 {@link FTS_SEGMENTER_V} 并重建索引。
 */

import { ValidationError } from './errors.ts';
import { maskNonCode } from './query.ts';

/** 切分规则版本；重建索引时记录到 `derived_state`。 */
export const FTS_SEGMENTER_V = 1;

const CJK_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]/u;
const SEARCHABLE_CHAR = /[\p{L}\p{N}]/u;

type Part = { cjk: boolean; text: string };

/** 把文本拆成交替的“中日文 run”与“其它文字”。 */
function splitRuns(text: string): Part[] {
  const parts: Part[] = [];
  for (const ch of text) {
    const cjk = CJK_CHAR.test(ch);
    const last = parts[parts.length - 1];
    if (last && last.cjk === cjk) last.text += ch;
    else parts.push({ cjk, text: ch });
  }
  return parts;
}

function bigrams(run: string): string[] {
  const chars = Array.from(run);
  const units: string[] = [];
  for (let i = 0; i + 1 < chars.length; i += 1) units.push(chars[i]! + chars[i + 1]!);
  return units;
}

/**
 * 切分文本供 FTS5 `unicode61` 分词：长度 ≥2 的中日文 run 输出重叠二字单元，
 * 单字 run 不输出，其它文字原样保留，两类文字之间用空格分界。
 */
export function segment(text: string): string {
  const out: string[] = [];
  for (const part of splitRuns(text)) {
    if (part.cjk) out.push(...bigrams(part.text));
    else out.push(part.text);
  }
  return out.join(' ');
}

function hasSingleCjkRun(word: string): boolean {
  return splitRuns(word).some((part) => part.cjk && Array.from(part.text).length === 1);
}

function fail(message: string): never {
  throw new ValidationError('invalid_field', message, 'sql');
}

/** 把 `fts()` 的文本编译成 FTS5 `MATCH` 表达式。 */
function compileMatch(text: string): string {
  const words = text.split(/\s+/u).filter((w) => w !== '');
  if (words.length === 0) fail('fts() 的文本不能为空');

  const groups: string[][] = [[]];
  words.forEach((word, index) => {
    if (word === 'OR') {
      if (index === 0 || index === words.length - 1 || words[index - 1] === 'OR') {
        fail("fts() 中的 OR 必须位于两个词之间");
      }
      groups.push([]);
      return;
    }
    if (hasSingleCjkRun(word)) {
      fail(`fts() 不支持单个汉字或假名（词“${word}”）；单字检索请改用 LIKE '%字%'`);
    }
    if (!SEARCHABLE_CHAR.test(word)) fail(`fts() 的词“${word}”没有可检索的字符`);
    groups[groups.length - 1]!.push(`"${segment(word).replaceAll('"', '""')}"`);
  });

  return groups.map((g) => `(${g.join(' ')})`).join(' OR ');
}

/**
 * 把语句代码区里的 `fts('…')` 展开成 SQL 字符串字面量（FTS5 表达式）。
 * 字符串和注释里的 `fts(` 不展开；参数不是单个字符串字面量时抛 `invalid_field`。
 */
export function expandFtsMacros(statement: string): string {
  const masked = maskNonCode(statement);
  const pattern = /\bfts\s*\(/giu;
  let out = '';
  let cursor = 0;

  for (let m = pattern.exec(masked); m; m = pattern.exec(masked)) {
    let i = m.index + m[0].length;
    const skipSpace = (): void => {
      while (i < statement.length && /\s/u.test(statement[i]!)) i += 1;
    };
    skipSpace();
    if (statement[i] !== "'") fail("fts() 只接受一个字符串字面量参数，例如 fts('渲染')");
    i += 1;
    let text = '';
    for (;;) {
      if (i >= statement.length) fail('fts() 的字符串字面量没有结束');
      const c = statement[i]!;
      if (c === "'") {
        if (statement[i + 1] === "'") {
          text += "'";
          i += 2;
          continue;
        }
        i += 1;
        break;
      }
      text += c;
      i += 1;
    }
    skipSpace();
    if (statement[i] !== ')') fail("fts() 只接受一个字符串字面量参数，例如 fts('渲染')");
    i += 1;

    out += statement.slice(cursor, m.index) + `'${compileMatch(text).replaceAll("'", "''")}'`;
    cursor = i;
    pattern.lastIndex = i;
  }
  return out + statement.slice(cursor);
}
