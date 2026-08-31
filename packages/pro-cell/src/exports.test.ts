import { describe, expect, it } from 'vitest';
import * as core from './core';
import * as publicApi from './index';
import * as reactApi from './react-entry';
import * as shared from './shared';

describe('公开入口', () => {
  it('从根入口导出常用 API', () => {
    expect(publicApi.SchemaParser).toBeTypeOf('function');
    expect(publicApi.DependencyTracker).toBeTypeOf('function');
    expect(publicApi.createForm).toBeTypeOf('function');
    expect(publicApi.SchemaForm).toBeTypeOf('function');
    expect(publicApi.ok).toBeTypeOf('function');
  });

  it('保留 core、react 和 shared 子路径入口', () => {
    expect(core.DependencyTracker).toBe(publicApi.DependencyTracker);
    expect(reactApi.createForm).toBe(publicApi.createForm);
    expect(shared.ok).toBe(publicApi.ok);
  });

  it('根入口解析器直接使用 React 默认注册表', () => {
    const parser = new publicApi.SchemaParser();
    const schema = { $comp: 'Fragment', children: [] } as const;

    expect(parser.parse(schema).ok).toBe(true);
    expect(parser.parseWithAst(schema).ok).toBe(true);
    expect(parser.parseOrThrow(schema)).toBeDefined();
  });
});
