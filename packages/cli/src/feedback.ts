/**
 * `liushui feedback` 核心逻辑。
 *
 * 规范：openspec/changes/feedback-minimal/specs/memory-cli/spec.md
 * 设计：openspec/changes/feedback-minimal/design.md
 */

import {
  parseFeedback,
  serializeFeedback,
  ValidationError,
  type FeedbackDocument,
} from '@liushui/core';

import { runAppend, type AppendCommandDeps, type AppendCommandResult } from './append.ts';
import { getServiceVersion } from './client.ts';
import { loadConfig } from './config.ts';
import { CliError } from './errors.ts';

export interface FeedbackCommandOptions {
  input: string;
  /** `--vault` 指定的库；至多一个。 */
  vaultNames: readonly string[];
}

export interface FeedbackCommandResult {
  id: string;
  appended: AppendCommandResult;
}

/**
 * 执行一次 feedback 命令。
 * 流程：
 * 1. 目标库校验：至多一个库（指定多个直接抛 CliError，退出码 2）。
 * 2. 输入解析与 core 校验：必须为合法的反馈 JSON，否则抛 CliError（带字段路径，退出码 2，不发请求）。
 * 3. 自动填入 service_version：未包含时调用 getServiceVersion，失败只打印一行 stderr 提示。
 * 4. 规范化序列化：serializeFeedback(canonicalJson)。
 * 5. 以 kind = 'retrieval_feedback' 走 runAppend 路径写入目标库。
 */
export async function runFeedbackCommand(
  options: FeedbackCommandOptions,
  deps: AppendCommandDeps & { stderr?: (text: string) => void },
): Promise<FeedbackCommandResult> {
  if (options.vaultNames.length > 1) {
    throw new CliError('feedback 命令至多只能指定一个库（--vault 至多一个）', 2);
  }

  // 1. 格式校验
  let doc: FeedbackDocument;
  try {
    doc = parseFeedback(options.input);
  } catch (error) {
    if (error instanceof ValidationError) {
      const fieldMsg = error.field ? `（字段：${error.field}）` : '';
      throw new CliError(`反馈格式错误${fieldMsg}：${error.message}\n参考模板见 skills/liushui/SKILL.md`, 2);
    }
    const msg = error instanceof Error ? error.message : String(error);
    throw new CliError(`反馈输入必须为合法的 JSON：${msg}\n参考模板见 skills/liushui/SKILL.md`, 2);
  }

  // 2. 加载目标库配置（单库）
  const config = loadConfig({
    ...(deps.configPath !== undefined ? { configPath: deps.configPath } : {}),
    ...(deps.envName !== undefined ? { env: deps.envName } : {}),
    vaultNames: options.vaultNames,
    envVars: deps.env,
  });

  const targetVault = config.vaults[0];
  if (!targetVault) {
    throw new CliError('未找到目标存储库', 2);
  }

  // 3. 自动填入 service_version（仅当为主反馈且未提供该字段时）
  if (!('refines' in doc) && doc.service_version === undefined) {
    const version = await getServiceVersion(targetVault, {
      ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
      timeoutMs: 3000,
    });
    if (version !== null) {
      doc.service_version = version;
    } else {
      if (deps.stderr) {
        deps.stderr(`liushui: 无法从 ${targetVault.name} 对应服务获取版本号，已省略 service_version\n`);
      }
    }
  }

  // 4. 规范化序列化
  const normalizedContent = serializeFeedback(doc);

  // 5. 调用 runAppend 写入
  const appended = await runAppend(
    {
      content: normalizedContent,
      kind: 'retrieval_feedback',
      vaultNames: options.vaultNames,
    },
    deps,
  );

  return {
    id: appended.id,
    appended,
  };
}
