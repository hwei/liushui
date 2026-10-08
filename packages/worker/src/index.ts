/**
 * Cloudflare Worker 入口。
 */

import { handleRequest } from './app.ts';
import type { Env } from './env.ts';

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

export default {
  fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    return handleRequest(request, env);
  },
};

export { handleRequest } from './app.ts';
export type { Env, VaultEntry } from './env.ts';
