#!/usr/bin/env node
/**
 * `mem` 可执行入口。需要 Node >= 24（直接运行 TypeScript）。
 */

import { main } from '../src/main.ts';

const exitCode = await main(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  env: process.env,
  cwd: process.cwd(),
});

process.exitCode = exitCode;
