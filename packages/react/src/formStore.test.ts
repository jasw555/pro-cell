import { describe, expect, it, vi } from 'vitest';
import {
  AbortError,
  DependencyCycleError,
  err,
  ReactionExecutionError,
  ValidationError,
} from '@jasw/pro-cell-shared';
import type { SchemaNode } from '@jasw/pro-cell-shared';
import { createForm } from './formStore';

const input = (name: string, extra: Record<string, unknown> = {}): SchemaNode =>
  ({
    $comp: 'Input',
    name,
    ...extra,
  }) as unknown as SchemaNode;

describe('createForm', () => {
  it('维护值、字段状态并执行可见性联动', () => {
    const schema = {
      $comp: 'Fragment',
      children: [
        input('country'),
        input('region', {
          reactions: [
            {
              when: "{{$deps.country === 'CN'}}",
              then: { setVisible: true },
              else: { setVisible: false },
            },
          ],
        }),
      ],
    };
    const form = createForm({ schema, initialValues: { country: 'US' } });
    expect(form.getValue('country')).toBe('US');
    expect(form.getFieldState('region').visible).toBe(false);
    expect(form.setValue('country', 'CN').ok).toBe(true);
    expect(form.getFieldState('region').visible).toBe(true);
    expect(form.setValue('country', 'CN').ok).toBe(true);
  });

  it('批量更新仍按实际前值触发联动级联', () => {
    const schema = {
      $comp: 'Fragment',
      children: [
        input('country'),
        input('region', {
          reactions: [
            {
              when: "{{$deps.country === 'CN'}}",
              then: { setVisible: true },
              else: { setVisible: false },
            },
          ],
        }),
      ],
    };
    const form = createForm({ schema, initialValues: { country: 'US' } });
    expect(form.setValues({ country: 'CN' }).ok).toBe(true);
    expect(form.getFieldState('region').visible).toBe(true);
  });

  it('批量更新时以 reaction 覆盖后的最终值保持 tracker 与 store 一致', () => {
    const schema = {
      $comp: 'Fragment',
      children: [
        input('trigger'),
        input('target', {
          reactions: [
            {
              when: '{{$deps.trigger === true}}',
              then: { setValue: 'derived' },
            },
          ],
        }),
        input('downstream', {
          reactions: [
            {
              when: "{{$deps.target === 'derived'}}",
              then: { setVisible: true },
              else: { setVisible: false },
            },
          ],
        }),
      ],
    };
    const form = createForm({
      schema,
      initialValues: { trigger: false, target: 'initial' },
    });

    expect(form.setValues({ trigger: true, target: 'manual' }).ok).toBe(true);
    expect(form.getValue('target')).toBe('derived');
    expect(form.getFieldState('downstream').visible).toBe(true);
  });

  it('订阅者重入 setValue 时不会回放过期的外层 reaction', () => {
    const schema = {
      $comp: 'Fragment',
      children: [
        input('source'),
        input('derived', {
          reactions: [
            {
              when: '{{$deps.source === 2}}',
              then: { setValue: 'two' },
              else: { setValue: 'other' },
            },
          ],
        }),
      ],
    };
    const form = createForm({ schema, initialValues: { source: 0, derived: 'initial' } });
    let reentered = false;
    form.subscribe((snapshot) => {
      if (!reentered && snapshot.values.source === 1) {
        reentered = true;
        expect(form.setValue('source', 2).ok).toBe(true);
      }
    });

    expect(form.setValue('source', 1).ok).toBe(true);
    expect(form.getValue('source')).toBe(2);
    expect(form.getValue('derived')).toBe('two');
  });

  it('按固定顺序执行 disabled 与 setValue reaction', () => {
    const schema = {
      $comp: 'Fragment',
      children: [
        input('kind'),
        input('company', {
          reactions: [
            {
              when: "{{$deps.kind === 'business'}}",
              then: { setDisabled: false, setValue: 'Acme' },
              else: { setDisabled: true, setValue: '' },
            },
          ],
        }),
      ],
    };
    const form = createForm({ schema, initialValues: { kind: 'personal' } });
    expect(form.getFieldState('company').disabled).toBe(true);
    expect(form.getValue('company')).toBe('');
    expect(form.getFieldState('company').touched).toBe(false);
    form.setValue('kind', 'business');
    expect(form.getFieldState('company').disabled).toBe(false);
    expect(form.getValue('company')).toBe('Acme');
    expect(form.getFieldState('company').touched).toBe(false);
  });

  it('在注册 schema 时检测并抛出循环依赖', () => {
    const schema = {
      $comp: 'Fragment',
      children: [
        input('a', { reactions: [{ when: '{{$deps.b === true}}', then: { setVisible: true } }] }),
        input('b', { reactions: [{ when: '{{$deps.a === true}}', then: { setVisible: true } }] }),
      ],
    };
    expect(() => createForm({ schema })).toThrow(DependencyCycleError);
  });

  it('执行 required、maxLength、pattern 并在首个错误处短路', async () => {
    const schema = input('phone', {
      rules: [
        { type: 'required', message: 'required' },
        { type: 'maxLength', value: 4, message: 'too long' },
        { type: 'pattern', value: '^1', message: 'pattern' },
      ],
    });
    const form = createForm({ schema });
    expect((await form.validateField('phone')).errors).toEqual(['required']);
    form.setValue('phone', '12345');
    expect((await form.validateField('phone')).errors).toEqual(['too long']);
    form.setValue('phone', 'abc');
    expect((await form.validateField('phone')).errors).toEqual(['pattern']);
    form.setValue('phone', '123');
    expect((await form.validateField('phone')).valid).toBe(true);
  });

  it('支持异步校验并取消过期运行', async () => {
    let calls = 0;
    let aborted = 0;
    const schema = input('remote', { rules: [{ type: 'custom', validatorId: 'remote' }] });
    const form = createForm({
      schema,
      validators: {
        remote: async (_value, context) => {
          calls += 1;
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, 20);
            context.signal.addEventListener(
              'abort',
              () => {
                aborted += 1;
                clearTimeout(timer);
                reject(new AbortError());
              },
              { once: true },
            );
          });
          return { ok: true, value: undefined };
        },
      },
    });
    const first = form.validateField('remote');
    await new Promise((resolve) => setTimeout(resolve, 2));
    const second = form.validateField('remote');
    expect((await first).cancelled).toBe(true);
    expect((await second).valid).toBe(true);
    expect(calls).toBe(2);
    expect(aborted).toBe(1);
    expect(form.getFieldState('remote').validating).toBe(false);
  });

  it('已取消的新校验调用也会先取消同字段旧运行', async () => {
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
    const first = form.validateField('remote');
    await started;
    const cancelled = new AbortController();
    cancelled.abort();
    const second = await form.validateField('remote', { signal: cancelled.signal });
    expect(second.cancelled).toBe(true);
    expect((await first).cancelled).toBe(true);
  });

  it('支持自定义校验器错误、提交、重置和销毁', async () => {
    const onSubmit = vi.fn(async (values: Readonly<Record<string, unknown>>) => values.email);
    const form = createForm({
      schema: input('email', { rules: [{ type: 'custom', validatorId: 'email' }] }),
      initialValues: { email: 'a@example.com' },
      validators: {
        email: async (value) =>
          value === 'a@example.com'
            ? { ok: true, value: undefined }
            : err(new ValidationError('邮箱无效')),
      },
      onSubmit,
    });
    expect((await form.submit()).ok).toBe(true);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    form.setValue('email', 'bad');
    expect((await form.validateField('email')).errors).toEqual(['邮箱无效']);
    form.reset();
    expect(form.getValue('email')).toBe('a@example.com');
    form.dispose();
    expect(form.setValue('email', 'x').ok).toBe(false);
  });

  it('外部 AbortSignal 取消校验且不遗留 validating 状态', async () => {
    const controller = new AbortController();
    const form = createForm({
      schema: input('value', { rules: [{ type: 'custom', validatorId: 'slow' }] }),
      validators: {
        slow: async (_value, context) => {
          await new Promise<void>((resolve) => setTimeout(resolve, 30));
          return context.signal.aborted
            ? err(new ValidationError('已取消'))
            : { ok: true, value: undefined };
        },
      },
    });
    const pending = form.validateField('value', { signal: controller.signal });
    controller.abort();
    expect((await pending).cancelled).toBe(true);
    expect(form.getFieldState('value').validating).toBe(false);
  });

  it('表单级校验取消时 valid 为 false 且不写入普通错误', async () => {
    const controller = new AbortController();
    const form = createForm({
      schema: input('value', { rules: [{ type: 'custom', validatorId: 'slow' }] }),
      validators: {
        slow: async (_value, context) => {
          await new Promise<void>((resolve) => setTimeout(resolve, 20));
          return context.signal.aborted
            ? err(new ValidationError('已取消'))
            : { ok: true, value: undefined };
        },
      },
    });
    const pending = form.validate({ signal: controller.signal });
    controller.abort();
    const result = await pending;
    expect(result.valid).toBe(false);
    expect(result.cancelled).toBe(true);
    expect(result.errors).toEqual({});
  });

  it('提交回调忽略 signal 且永不结束时，外部取消仍及时返回 AbortError', async () => {
    const controller = new AbortController();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let releaseSubmit!: (value: string) => void;
    const blocked = new Promise<string>((resolve) => {
      releaseSubmit = resolve;
    });
    const onSubmit = vi.fn(() => {
      markStarted();
      return blocked;
    });
    const form = createForm({ onSubmit });

    const pending = form.submit({ signal: controller.signal });
    await started;
    controller.abort();

    const result = await pending;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(AbortError);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    // 释放底层 Promise，避免测试结束后保留无意义的悬挂任务。
    releaseSubmit('late');
  });

  it('异步校验期间字段值变化会取消过期的表单级聚合结果', async () => {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let releaseSlow!: () => void;
    const form = createForm({
      schema: {
        $comp: 'Fragment',
        children: [
          input('slow', { rules: [{ type: 'custom', validatorId: 'slow' }] }),
          input('other', { rules: [{ type: 'required' }] }),
        ],
      },
      initialValues: { slow: 'ok', other: 'old' },
      validators: {
        slow: async () => {
          markStarted();
          await new Promise<void>((resolve) => {
            releaseSlow = resolve;
          });
          return { ok: true, value: undefined };
        },
      },
    });

    const pending = form.validate();
    await started;
    expect(form.setValue('other', 'new').ok).toBe(true);
    releaseSlow();

    const result = await pending;
    expect(result.valid).toBe(false);
    expect(result.cancelled).toBe(true);
    expect(result.errors).toEqual({});
  });

  it('单字段异步校验会在其他字段变化时丢弃过期上下文', async () => {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let releaseValidator!: () => void;
    let validationSignal: AbortSignal | undefined;
    const form = createForm({
      schema: {
        $comp: 'Fragment',
        children: [
          input('password'),
          input('confirm', { rules: [{ type: 'custom', validatorId: 'samePassword' }] }),
        ],
      },
      initialValues: { password: 'old', confirm: 'old' },
      validators: {
        samePassword: async (value, context) => {
          validationSignal = context.signal;
          markStarted();
          await new Promise<void>((resolve) => {
            releaseValidator = resolve;
          });
          return value === context.values.password
            ? { ok: true, value: undefined }
            : err(new ValidationError('两次密码不一致'));
        },
      },
    });

    const pending = form.validateField('confirm');
    await started;
    expect(form.setValue('password', 'new').ok).toBe(true);
    const abortedAfterDependencyChanged = validationSignal?.aborted;
    releaseValidator();

    const result = await pending;
    expect(abortedAfterDependencyChanged).toBe(true);
    expect(result.cancelled).toBe(true);
    expect(form.getFieldState('confirm').validating).toBe(false);
  });

  it('提交不会使用异步校验开始后变更字段的过期结果', async () => {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let releaseSlow!: () => void;
    const onSubmit = vi.fn(async () => 'submitted');
    const form = createForm({
      schema: {
        $comp: 'Fragment',
        children: [
          input('slow', { rules: [{ type: 'custom', validatorId: 'slow' }] }),
          input('other', { rules: [{ type: 'required' }] }),
        ],
      },
      initialValues: { slow: 'ok', other: 'old' },
      validators: {
        slow: async () => {
          markStarted();
          await new Promise<void>((resolve) => {
            releaseSlow = resolve;
          });
          return { ok: true, value: undefined };
        },
      },
      onSubmit,
    });

    const pending = form.submit();
    await started;
    expect(form.setValue('other', 'new').ok).toBe(true);
    releaseSlow();

    const result = await pending;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(AbortError);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('对原型键路径保持安全且不抛出运行时异常', () => {
    const form = createForm();
    for (const path of ['toString', 'constructor', '__proto__']) {
      expect(form.getValue(path)).toBeUndefined();
      expect(form.getFieldState(path).errors).toEqual([]);
      expect(form.setVisible(path, false).ok).toBe(true);
      expect(form.setDisabled(path, true).ok).toBe(true);
      expect(form.setValue(path, 'safe').ok).toBe(true);
      expect(form.getValue(path)).toBe('safe');
    }
  });

  it('将订阅者异常封装为 Result 错误且不阻断状态更新', () => {
    const form = createForm({ initialValues: { value: 0 } });
    form.subscribe(() => {
      throw new Error('listener failed');
    });

    const result = form.setValue('value', 1);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(ReactionExecutionError);
    expect(form.getValue('value')).toBe(1);
  });

  it('将快照订阅者异常封装为 Result 错误', () => {
    const form = createForm({ initialValues: { value: 0 } });
    form.subscribeSnapshot?.(() => {
      throw new Error('snapshot listener failed');
    });

    const result = form.setValue('value', 1);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(ReactionExecutionError);
    expect(form.getValue('value')).toBe(1);
  });

  it('将运行时传入的非法批量值和重置值封装为 Result 错误', () => {
    const form = createForm();
    const invalidValues = form.setValues(null as unknown as Readonly<Record<string, unknown>>);
    const invalidReset = form.reset([] as unknown as Readonly<Record<string, unknown>>);
    expect(invalidValues.ok).toBe(false);
    expect(invalidReset.ok).toBe(false);
  });

  it('重置值读取失败时保留正在运行的校验', async () => {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let releaseValidator!: () => void;
    let validationSignal: AbortSignal | undefined;
    const form = createForm({
      schema: input('value', { rules: [{ type: 'custom', validatorId: 'slow' }] }),
      validators: {
        slow: async (_value, context) => {
          validationSignal = context.signal;
          markStarted();
          await new Promise<void>((resolve) => {
            releaseValidator = resolve;
          });
          return { ok: true, value: undefined };
        },
      },
    });
    const pending = form.validateField('value');
    await started;
    const unreadable = new Proxy<Record<string, unknown>>(
      {},
      {
        ownKeys: () => {
          throw new Error('cannot enumerate values');
        },
      },
    );

    const reset = form.reset(unreadable);
    const abortedAfterFailedReset = validationSignal?.aborted;
    const validatingAfterFailedReset = form.getFieldState('value').validating;
    releaseValidator();
    const validation = await pending;

    expect(reset.ok).toBe(false);
    expect(abortedAfterFailedReset).toBe(false);
    expect(validatingAfterFailedReset).toBe(true);
    expect(validation.valid).toBe(true);
    expect(form.getFieldState('value').validating).toBe(false);
  });

  it('销毁后不会重新执行校验或提交', async () => {
    const onSubmit = vi.fn(async () => 'submitted');
    const form = createForm({ onSubmit });
    form.dispose();

    const validation = await form.validate();
    const submission = await form.submit();

    expect(validation.cancelled).toBe(true);
    expect(submission.ok).toBe(false);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
