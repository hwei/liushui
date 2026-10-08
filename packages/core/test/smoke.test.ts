import { describe, expect, it } from 'vitest';

import { SCHEMA_VERSION } from '../src/record.ts';

describe('核心包可加载', () => {
  it('导出 schema 版本', () => {
    expect(SCHEMA_VERSION).toBe(1);
  });
});
