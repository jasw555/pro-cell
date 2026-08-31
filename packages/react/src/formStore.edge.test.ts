import { describe, expect, it, vi } from 'vitest';
import {
  AbortError,
  FormSubmitError,
  SchemaParseError,
  type SchemaNode,
} from '@jasw/pro-cell-shared';
import { createComponentRegistry } from './registry';
import { createForm } from './formStore';

function input(name: string, extra: Partial<SchemaNode> = {}): SchemaNode {
  return { $comp: 'Input', name, ...extra };
}

describe('createForm 运行时边界', () => {
  it('拒绝非法初始值、不可枚举初始值和损坏的 Schema', () => {
    expect(() =>
      createForm({
        initialValues: null as unknown as Readonly<Record<string, unknown>>,
      }),
    ).toThrow(FormSubmitError);
    expect(() =>
      createForm({
        initialValues: [] as unknown as Readonly<Record<string, unknown>>,
      }),
    ).toThrow(FormSubmitError);

    const unreadable = new Proxy<Record<string, unknown>>(
      {},
      {
        ownKeys: () => {
          throw new Error('cannot enumerate initial values');
        },
      },
    );
    expect(() => createForm({ initialValues: unreadable })).toThrow(FormSubmitError);
    expect(() => createForm({ schema: '{' })).toThrow(SchemaParseError);
    expect(() => createForm({ schema: {} as unknown as SchemaNode })).toThrow(SchemaParseError);
  });

  it('提供稳定且隔离的状态快照，并保留 Schema/注册表引用', () => {
    const schema = input('declared');
    const registry = createComponentRegistry();
    const form = createForm({
      schema,
      registry,
      initialValues: { declared: 'initial', extra: 1 },
    });

    expect(form.getValues()).toEqual({ declared: 'initial', extra: 1 });
    expect(form.getSchema?.()?.name).toBe('declared');
    expect(form.getRegistry?.()).toBe(registry);
    const first = form.getSnapshot?.();
    const stable = form.getSnapshot?.();
    expect(stable).toBe(first);

    expect(form.setValue('dynamic', 'created').ok).toBe(true);
    const changed = form.getSnapshot?.();
    expect(changed).not.toBe(first);
    expect(changed?.version).toBeGreaterThan(first?.version ?? -1);
    expect(changed?.values.dynamic).toBe('created');

    const values = form.getValues() as Record<string, unknown>;
    values.declared = 'outside';
    expect(form.getValue('declared')).toBe('initial');
  });

  it('允许在未声明路径上设置状态并执行空规则校验', async () => {
    const form = createForm();

    expect(form.setDisabled('runtime.disabled', true).ok).toBe(true);
    expect(form.getFieldState('runtime.disabled').disabled).toBe(true);
    expect(form.setVisible('runtime.visible', false).ok).toBe(true);
    expect(form.getFieldState('runtime.visible').visible).toBe(false);
    const validation = await form.validateField('runtime.value');
    expect(validation.valid).toBe(true);
    expect(validation.errors).toEqual([]);
  });

  it('批量值无法读取时返回错误，订阅者重入覆盖值时跳过过期通知', () => {
    const form = createForm({ initialValues: { first: 0, second: 0 } });
    const unreadable = new Proxy<Record<string, unknown>>(
      {},
      {
        ownKeys: () => {
          throw new Error('cannot enumerate batch');
        },
      },
    );
    const failed = form.setValues(unreadable);
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.error).toBeInstanceOf(FormSubmitError);

    let reentered = false;
    form.subscribe((snapshot) => {
      if (!reentered && snapshot.values.first === 1) {
        reentered = true;
        expect(form.setValue('second', 2).ok).toBe(true);
      }
    });
    expect(form.setValues({ first: 1, second: 1 }).ok).toBe(true);
    expect(form.getValues()).toEqual({ first: 1, second: 2 });
  });
});

describe('校验与提交事务', () => {
  it('同字段写值会取消正在运行的异步校验', async () => {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let validationSignal: AbortSignal | undefined;
    const form = createForm({
      schema: input('remote', { rules: [{ type: 'custom', validatorId: 'slow' }] }),
      validators: {
        slow: async (_value, { signal }) => {
          validationSignal = signal;
          markStarted();
          await new Promise<void>((resolve) => {
            signal.addEventListener('abort', () => resolve(), { once: true });
          });
          return { ok: true, value: undefined };
        },
      },
    });

    const pending = form.validateField('remote');
    await started;
    expect(form.setValue('remote', 'new value').ok).toBe(true);
    const result = await pending;

    expect(validationSignal?.aborted).toBe(true);
    expect(result.cancelled).toBe(true);
    expect(form.getFieldState('remote').validating).toBe(false);
  });

  it('聚合字段错误、阻止无效提交，并在修复后直接返回值快照', async () => {
    const schema: SchemaNode = {
      $comp: 'Fragment',
      children: [
        input('first', { rules: [{ type: 'required', message: 'first required' }] }),
        input('second', { rules: [{ type: 'required', message: 'second required' }] }),
      ],
    };
    const form = createForm({ schema, initialValues: { first: '', second: '' } });

    const validation = await form.validate();
    expect(validation.valid).toBe(false);
    expect(validation.errors).toEqual({
      first: ['first required'],
      second: ['second required'],
    });
    const rejected = await form.submit();
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error).toBeInstanceOf(FormSubmitError);

    expect(form.setValues({ first: 'A', second: 'B' }).ok).toBe(true);
    const submitted = await form.submit();
    expect(submitted.ok).toBe(true);
    if (submitted.ok) expect(submitted.value).toEqual({ first: 'A', second: 'B' });
  });

  it.each([
    ['字符串异常', 'string failure', 'string failure'],
    ['Error 异常', new Error('error failure'), 'error failure'],
    ['带 message 的对象', { message: 'object failure' }, 'object failure'],
    ['无文案异常', 42, '表单提交失败'],
  ])('封装 onSubmit 的%s', async (_label, cause, expectedMessage) => {
    const form = createForm({
      onSubmit: () => {
        throw cause;
      },
    });

    const result = await form.submit();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(FormSubmitError);
      expect(result.error.message).toBe(expectedMessage);
    }
  });

  it('错误对象 message 读取失败时使用稳定的提交失败文案', async () => {
    const cause = Object.defineProperty({}, 'message', {
      get: () => {
        throw new Error('message getter failure');
      },
    });
    const form = createForm({
      onSubmit: () => {
        throw cause;
      },
    });

    const result = await form.submit();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toBe('表单提交失败');
  });

  it('onSubmit 执行期间改值会丢弃旧快照对应的返回值', async () => {
    const form = createForm({
      initialValues: { value: 'before' },
      onSubmit: async (_values, { form: currentForm }) => {
        expect(currentForm.setValue('value', 'after').ok).toBe(true);
        await Promise.resolve();
        return 'stale result';
      },
    });

    const result = await form.submit();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(AbortError);
    expect(form.getValue('value')).toBe('after');
  });

  it('提交开始前已取消的外部 signal 不会执行 onSubmit', async () => {
    const controller = new AbortController();
    controller.abort('cancel before submit');
    const onSubmit = vi.fn(() => 'submitted');
    const form = createForm({ onSubmit });

    const result = await form.submit({ signal: controller.signal });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(AbortError);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe('重置与销毁', () => {
  it('显式空重置仍保留 Schema 字段，并使销毁后的所有写操作失败', () => {
    const form = createForm({
      schema: input('declared'),
      initialValues: { declared: 'before', extra: 'remove me' },
    });

    expect(form.reset({}).ok).toBe(true);
    expect(form.getValues()).toEqual({ declared: undefined });
    expect(form.getFieldState('declared').touched).toBe(false);

    form.dispose();
    form.dispose();
    expect(form.setValue('declared', 'next').ok).toBe(false);
    expect(form.setValues({ declared: 'next' }).ok).toBe(false);
    expect(form.setVisible('declared', false).ok).toBe(false);
    expect(form.setDisabled('declared', true).ok).toBe(false);
    expect(form.reset({ declared: 'next' }).ok).toBe(false);
  });

  it('dispose 会取消字段校验并清理 validating 状态', async () => {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const form = createForm({
      schema: input('remote', { rules: [{ type: 'custom', validatorId: 'slow' }] }),
      validators: {
        slow: async (_value, { signal }) => {
          markStarted();
          await new Promise<void>((resolve) => {
            signal.addEventListener('abort', () => resolve(), { once: true });
          });
          return { ok: true, value: undefined };
        },
      },
    });

    const pending = form.validateField('remote');
    await started;
    expect(form.getFieldState('remote').validating).toBe(true);
    form.dispose();
    expect(form.getFieldState('remote').validating).toBe(false);
    expect((await pending).cancelled).toBe(true);
  });

  it('dispose 会让忽略 signal 的提交及时返回取消结果', async () => {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let releaseSubmit!: () => void;
    const blocked = new Promise<string>((resolve) => {
      releaseSubmit = () => resolve('late result');
    });
    const form = createForm({
      onSubmit: () => {
        markStarted();
        return blocked;
      },
    });

    const pending = form.submit();
    await started;
    form.dispose();
    const result = await pending;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(AbortError);
    releaseSubmit();
  });
});
