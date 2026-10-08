import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { collectMeta, defaultGitRunner } from '../src/meta.ts';
import { makeTempDir } from './utils.ts';

const git = (cwd: string, ...args: string[]): void => {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
};

describe('meta 自动采集（task 5.2）', () => {
  it('在 git 仓库内含 git.repo/branch/commit/dirty', () => {
    const { dir, remove } = makeTempDir();
    try {
      git(dir, 'init', '-b', 'main');
      git(dir, 'remote', 'add', 'origin', 'https://user:ghp_secret@github.com/org/repo.git');
      writeFileSync(join(dir, 'a.txt'), 'hello');
      git(dir, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'add', 'a.txt');
      git(dir, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-m', 'init');

      const meta = collectMeta({
        cwd: dir,
        env: {},
        hostname: () => 'test-host',
        pid: 123,
        ppid: 1,
        argv0: '/usr/bin/node',
      });

      expect(meta['host']).toBe('test-host');
      expect(meta['cwd']).toBe(dir);
      expect(meta['tz']).toBeDefined();
      expect(meta['src']).toBe('cli');
      expect(meta['os']).toMatchObject({ platform: expect.any(String) });
      expect(meta['proc']).toMatchObject({ pid: 123, ppid: 1 });
      expect(meta['cli']).toMatchObject({ version: expect.any(String) });

      const gitMeta = meta['git'] as Record<string, unknown>;
      expect(gitMeta['branch']).toBe('main');
      expect(gitMeta['commit']).toMatch(/^[0-9a-f]{40}$/);
      expect(gitMeta['dirty']).toBe(false);
      expect(gitMeta['repo']).toBe('github.com/org/repo.git');
      expect(JSON.stringify(gitMeta)).not.toContain('ghp_secret');

      writeFileSync(join(dir, 'untracked.txt'), 'x');
      const dirtyMeta = collectMeta({ cwd: dir, env: {}, runGit: defaultGitRunner });
      expect((dirtyMeta['git'] as Record<string, unknown>)['dirty']).toBe(true);
    } finally {
      remove();
    }
  });

  it('不在 git 仓库内时不含任何 git.* 键', () => {
    const { dir, remove } = makeTempDir();
    try {
      const meta = collectMeta({ cwd: dir, env: {} });
      expect(meta['git']).toBeUndefined();
      expect(Object.keys(meta).some((key) => key.startsWith('git'))).toBe(false);
      expect(meta['cwd']).toBe(dir);
    } finally {
      remove();
    }
  });

  it('采集不到的字段被省略而不是填空串', () => {
    const meta = collectMeta({
      cwd: '/tmp/x',
      env: {},
      hostname: () => '',
      runGit: () => null,
    });
    expect(meta['host']).toBeUndefined();
    expect(meta['git']).toBeUndefined();
    expect(JSON.stringify(meta)).not.toContain('""');
  });

  it('能识别 agent 名称与会话', () => {
    const explicit = collectMeta({
      cwd: '/tmp/x',
      env: { LIUSHUI_AGENT_NAME: 'pi', LIUSHUI_AGENT_SESSION: 's-42' },
      runGit: () => null,
    });
    expect(explicit['agent']).toEqual({ name: 'pi', session: 's-42' });

    const detected = collectMeta({
      cwd: '/tmp/x',
      env: { CLAUDECODE: '1', CLAUDE_SESSION_ID: 'claude-session' },
      runGit: () => null,
    });
    expect(detected['agent']).toEqual({ name: 'claude', session: 'claude-session' });

    const none = collectMeta({ cwd: '/tmp/x', env: {}, runGit: () => null });
    expect(none['agent']).toBeUndefined();
  });
});
