import { describe, expect, it } from 'vitest';

import type { Meta } from '@liushui/core';

import { buildMetaByVault } from '../src/append.ts';
import type { ResolvedVault } from '../src/config.ts';
import { redactMeta } from '../src/redact.ts';

const META: Meta = {
  host: 'laptop',
  cwd: '/repo',
  git: { repo: 'github.com/org/repo.git', branch: 'main', commit: 'abc', dirty: false },
  tz: 'Asia/Shanghai',
};

describe('按库脱敏（task 5.4）', () => {
  it('按点号路径删除字段，且不修改入参', () => {
    const result = redactMeta(META, ['cwd', 'git.repo']);
    expect(result).toEqual({
      host: 'laptop',
      git: { branch: 'main', commit: 'abc', dirty: false },
      tz: 'Asia/Shanghai',
    });
    expect(META['cwd']).toBe('/repo');
    expect((META['git'] as Meta)['repo']).toBe('github.com/org/repo.git');
  });

  it('空路径与不存在的路径被忽略', () => {
    expect(redactMeta(META, ['', 'nope.deep', '...'])).toEqual(META);
  });

  it('按库脱敏：各库 meta 不同而 id 不受影响', () => {
    const vaults: ResolvedVault[] = [
      { name: 'personal', url: 'http://p', token: 'p', redact: [] },
      { name: 'work', url: 'http://w', token: 'w', redact: ['cwd', 'git.repo'] },
    ];
    const built = buildMetaByVault(META, vaults);
    const personal = built.find((item) => item.vault.name === 'personal')!.meta;
    const work = built.find((item) => item.vault.name === 'work')!.meta;

    expect(personal['cwd']).toBe('/repo');
    expect(work['cwd']).toBeUndefined();
    expect((personal['git'] as Meta)['repo']).toBe('github.com/org/repo.git');
    expect((work['git'] as Meta)['repo']).toBeUndefined();
    // 两个库的 meta 不同，但共用同一份核心字段（id 与 meta 无关）。
    expect(personal).not.toEqual(work);
    expect((work['git'] as Meta)['branch']).toBe('main');
  });
});
