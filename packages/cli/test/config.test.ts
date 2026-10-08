import { describe, expect, it } from 'vitest';

import { join } from 'node:path';

import {
  defaultConfigPath,
  loadConfig,
  parseConfig,
  readConfiguredTokens,
} from '../src/config.ts';
import { main } from '../src/main.ts';
import { createFetchStub, createIo, jsonResponse, writeTempConfig } from './utils.ts';

const SAMPLE = {
  env: 'dev',
  environments: {
    dev: {
      defaultVault: 'personal',
      vaults: {
        personal: { url: 'http://127.0.0.1:8787', token: 'dev-personal-token' },
        work: {
          url: 'http://127.0.0.1:8788',
          token: 'dev-work-token',
          redact: ['cwd', 'git.repo'],
        },
      },
    },
    prod: {
      defaultVault: 'personal',
      vaults: {
        personal: { url: 'https://mem.example.com', token: 'prod-personal-token' },
      },
    },
  },
};

describe('配置（task 5.1）', () => {
  it('默认路径在 ~/.config/liushui/config.json', () => {
    expect(defaultConfigPath(join('/home/me'))).toBe(
      join('/home/me', '.config', 'liushui', 'config.json'),
    );
  });

  it('解析配置并选中默认库', () => {
    const file = writeTempConfig(SAMPLE);
    try {
      const config = loadConfig({ configPath: file.path });
      expect(config.env).toBe('dev');
      expect(config.vaults).toHaveLength(1);
      expect(config.vaults[0]).toMatchObject({
        name: 'personal',
        url: 'http://127.0.0.1:8787',
        token: 'dev-personal-token',
        redact: [],
      });
    } finally {
      file.remove();
    }
  });

  it('支持按 --vault 选择多个库并应用各自脱敏配置', () => {
    const file = writeTempConfig(SAMPLE);
    try {
      const config = loadConfig({ configPath: file.path, vaultNames: ['personal', 'work'] });
      expect(config.vaults.map((v) => v.name)).toEqual(['personal', 'work']);
      expect(config.vaults[1]?.redact).toEqual(['cwd', 'git.repo']);
    } finally {
      file.remove();
    }
  });

  it('支持 dev/prod 环境选择，环境可由参数覆盖', () => {
    const file = writeTempConfig(SAMPLE);
    try {
      expect(loadConfig({ configPath: file.path, env: 'prod' }).vaults[0]?.url).toBe(
        'https://mem.example.com',
      );
      expect(
        loadConfig({ configPath: file.path, envVars: { LIUSHUI_ENV: 'prod' } }).vaults[0]?.token,
      ).toBe('prod-personal-token');
    } finally {
      file.remove();
    }
  });

  it('LIUSHUI_CONFIG 可指定配置文件', () => {
    const file = writeTempConfig(SAMPLE);
    try {
      const config = loadConfig({ envVars: { LIUSHUI_CONFIG: file.path } });
      expect(config.path).toBe(file.path);
    } finally {
      file.remove();
    }
  });

  it('未配置时报错并给出配置指引，且不发出请求', async () => {
    const stub = createFetchStub(() => jsonResponse({ id: 'x', created: true }));
    const io = createIo({
      env: { LIUSHUI_CONFIG: '/definitely/not/here/config.json' },
      fetchImpl: stub.fetchImpl,
    });
    const code = await main(['append', '内容'], io);
    expect(code).toBe(2);
    expect(io.stderrText()).toContain('未找到配置文件');
    expect(io.stderrText()).toContain('environments');
    expect(stub.calls).toHaveLength(0);
  });

  it('未知库名与未知环境给出可用列表', () => {
    const file = writeTempConfig(SAMPLE);
    try {
      expect(() => loadConfig({ configPath: file.path, vaultNames: ['nope'] })).toThrowError(
        /没有库 nope（可选：personal, work）/,
      );
      expect(() => loadConfig({ configPath: file.path, env: 'staging' })).toThrowError(
        /没有环境 staging（可选：dev, prod）/,
      );
    } finally {
      file.remove();
    }
  });

  it('没有默认库且未指定 --vault 时报错', () => {
    const file = writeTempConfig({
      environments: { dev: { vaults: { personal: { url: 'http://x', token: 't' } } } },
    });
    try {
      expect(() => loadConfig({ configPath: file.path })).toThrowError(/没有默认库/);
    } finally {
      file.remove();
    }
  });

  it('校验配置结构', () => {
    expect(() => parseConfig('not json')).toThrowError(/不是合法 JSON/);
    expect(() => parseConfig('{}')).toThrowError(/缺少 environments/);
    expect(() =>
      parseConfig(JSON.stringify({ environments: { dev: { vaults: {} } } })),
    ).toThrowError(/未配置任何库/);
    expect(() =>
      parseConfig(
        JSON.stringify({ environments: { dev: { vaults: { a: { url: 'http://x' } } } } }),
      ),
    ).toThrowError(/缺少非空 token/);
    expect(() =>
      parseConfig(
        JSON.stringify({
          environments: { dev: { defaultVault: 'zzz', vaults: { a: { url: 'http://x', token: 't' } } } },
        }),
      ),
    ).toThrowError(/defaultVault 指向未配置的库/);
  });

  it('readConfiguredTokens 覆盖所有环境的 token', () => {
    const file = writeTempConfig(SAMPLE);
    try {
      expect(readConfiguredTokens(file.path).sort()).toEqual(
        ['dev-personal-token', 'dev-work-token', 'prod-personal-token'].sort(),
      );
      expect(readConfiguredTokens('/definitely/not/here.json')).toEqual([]);
    } finally {
      file.remove();
    }
  });

  it('失败输出中不包含 token', async () => {
    const file = writeTempConfig(SAMPLE);
    try {
      const stub = createFetchStub(
        () => new Response('token dev-personal-token leaked', { status: 500 }),
      );
      const io = createIo({
        env: { LIUSHUI_CONFIG: file.path },
        fetchImpl: stub.fetchImpl,
        maxAttempts: 1,
        sleep: async () => undefined,
      });
      const code = await main(['append', '内容'], io);
      expect(code).toBe(1);
      const combined = io.stdoutText() + io.stderrText();
      expect(combined).not.toContain('dev-personal-token');
      expect(stub.calls[0]?.token).toBe('dev-personal-token');
    } finally {
      file.remove();
    }
  });

  it('未配置库时不发出请求（没有配置文件）', async () => {
    const stub = createFetchStub(() => jsonResponse({ id: 'x', created: true }));
    const io = createIo({ env: { LIUSHUI_CONFIG: '/nope/config.json' }, fetchImpl: stub.fetchImpl });
    await main(['append', '内容'], io);
    expect(stub.calls).toHaveLength(0);
  });
});
