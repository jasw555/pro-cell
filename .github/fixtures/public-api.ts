import { SchemaForm, createForm, registerComponent } from '@jasw/pro-cell';
import { DependencyTracker, SchemaParser } from '@jasw/pro-cell/core';
import { SchemaRenderer, useForm } from '@jasw/pro-cell/react';
import { ok, type Result } from '@jasw/pro-cell/shared';

// 这个文件只在 CI 的隔离消费项目中做类型检查，覆盖根入口和三个子路径。
const form = createForm({ initialValues: { ready: true } });
const parsed = new SchemaParser().normalize({ $comp: 'Fragment' });
const tracker = new DependencyTracker();
const result: Result<number, Error> = ok(1);

void [SchemaForm, SchemaRenderer, useForm, registerComponent, form, parsed, tracker, result];
