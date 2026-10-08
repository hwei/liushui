import { describe, expect, it } from 'vitest';

import { sanitizeGitRemote } from '../src/sanitize.ts';

describe('敏感信息清洗（task 5.3）', () => {
  it('远端含用户名与 token 时只保留主机与路径', () => {
    const result = sanitizeGitRemote('https://user:ghp_xxx@github.com/org/repo.git');
    expect(result).toBe('github.com/org/repo.git');
    expect(result).not.toContain('user');
    expect(result).not.toContain('ghp_xxx');
    expect(result).not.toContain('@');
  });

  it('scp 形式的远端去掉用户名', () => {
    expect(sanitizeGitRemote('git@github.com:org/repo.git')).toBe('github.com/org/repo.git');
    expect(sanitizeGitRemote('user@gitlab.example.com:group/sub/repo.git')).toBe(
      'gitlab.example.com/group/sub/repo.git',
    );
  });

  it('ssh 形式带端口与 userinfo', () => {
    expect(sanitizeGitRemote('ssh://alice:secret@git.example.com:2222/org/repo.git')).toBe(
      'git.example.com:2222/org/repo.git',
    );
  });

  it('干净的 https 远端保持不变（去掉 scheme）', () => {
    expect(sanitizeGitRemote('https://github.com/org/repo.git')).toBe('github.com/org/repo.git');
    expect(sanitizeGitRemote('https://github.com/org/repo/')).toBe('github.com/org/repo');
  });

  it('本地路径与非法输入返回 null（调用方据此省略字段）', () => {
    expect(sanitizeGitRemote('/home/me/repo')).toBeNull();
    expect(sanitizeGitRemote('C:\\Users\\me\\repo')).toBeNull();
    expect(sanitizeGitRemote('file:///home/me/repo')).toBeNull();
    expect(sanitizeGitRemote('')).toBeNull();
    expect(sanitizeGitRemote('   ')).toBeNull();
    expect(sanitizeGitRemote('mailto:someone@example.com')).toBeNull();
  });

  it('结果中永远不含 @', () => {
    for (const remote of [
      'https://user:pass@host/path.git',
      'git@host:path.git',
      'ssh://user@host/path.git',
      'https://host/path.git',
    ]) {
      const result = sanitizeGitRemote(remote);
      if (result !== null) expect(result).not.toContain('@');
    }
  });
});
