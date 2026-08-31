import { describe, expect, it, vi } from 'vitest';
import { err, isErr, ok, type Result } from './result';
import { AbortError, ValidationEngineError, ValidationError } from './errors';
import type { Validator } from './schema';
import {
  createCombinedController,
  combineSignals,
  isEmptyValue,
  maxLength,
  pattern,
  required,
  validateBuiltInRule,
  validateValue,
  validateValueSync,
  runValidator,
} from './validation';

describe('validation rules', () => {
  it('handles required, maxLength and pattern', () => {
    expect(isEmptyValue(undefined)).toBe(true);
    expect(isEmptyValue(null)).toBe(true);
    expect(isEmptyValue('')).toBe(true);
    expect(isEmptyValue([])).toBe(true);
    expect(isEmptyValue(0)).toBe(false);
    expect(validateBuiltInRule('', { type: 'required' }, 'name')).toBeInstanceOf(ValidationError);
    expect(validateBuiltInRule([], { type: 'required' })).toBeInstanceOf(ValidationError);
    expect(validateBuiltInRule('ok', { type: 'required' })).toBeUndefined();
    expect(validateBuiltInRule('abcd', { type: 'maxLength', value: 3 }, 'name')).toBeInstanceOf(
      ValidationError,
    );
    expect(validateBuiltInRule([1, 2], { type: 'maxLength', value: 3 })).toBeUndefined();
    expect(validateBuiltInRule(42, { type: 'maxLength', value: 3 })).toBeUndefined();
    expect(validateBuiltInRule('', { type: 'pattern', value: '^z' })).toBeUndefined();
    expect(validateBuiltInRule(42, { type: 'pattern', value: '^z' })).toBeUndefined();
    expect(validateBuiltInRule('abc', { type: 'pattern', value: '^a' })).toBeUndefined();
    expect(validateBuiltInRule('abc', { type: 'pattern', value: '^z' })).toBeInstanceOf(
      ValidationError,
    );
    expect(validateBuiltInRule('abc', { type: 'pattern', value: '[', flags: 'g' })).toBeInstanceOf(
      ValidationError,
    );
    expect(validateBuiltInRule('abc', { type: 'required', message: '' })).toBeUndefined();
    expect(validateBuiltInRule('abc', { type: 'unknown' } as never)).toBeUndefined();
  });

  it('exposes reusable rule factories and short-circuits', async () => {
    const context = { field: 'name', values: {}, signal: new AbortController().signal };
    expect((await required()('', context)).ok).toBe(false);
    expect((await maxLength(2)('abc', context)).ok).toBe(false);
    expect((await pattern('^a')('abc', context)).ok).toBe(true);
    const result = await validateValue(
      '',
      [{ type: 'required' }, { type: 'pattern', value: '^x' }],
      {
        field: 'name',
      },
    );
    expect(result).toMatchObject({ valid: false, errors: [{ rule: 'required' }] });
    expect(validateValueSync('ok', [{ type: 'required' }]).ok).toBe(true);
    expect(
      await validateValue('ok', [{ type: 'required' }, { type: 'maxLength', value: 10 }]),
    ).toMatchObject({ valid: true });
  });

  it('preserves custom messages in reusable rule factories', async () => {
    const context = { field: 'name', values: {}, signal: new AbortController().signal };

    const requiredRule = required('请输入姓名');
    const requiredFailure = await requiredRule('', context);
    expect(isErr(requiredFailure) && requiredFailure.error).toMatchObject({
      message: '请输入姓名',
    });
    expect((await requiredRule('Jasw', context)).ok).toBe(true);

    const maxLengthRule = maxLength(2, '最多两个字符');
    const maxLengthFailure = await maxLengthRule('Jasw', context);
    expect(isErr(maxLengthFailure) && maxLengthFailure.error).toMatchObject({
      message: '最多两个字符',
    });
    expect((await maxLengthRule('J', context)).ok).toBe(true);

    const patternRule = pattern('^jasw$', '', '格式不正确');
    const patternFailure = await patternRule('other', context);
    expect(isErr(patternFailure) && patternFailure.error).toMatchObject({ message: '格式不正确' });
    expect((await patternRule('jasw', context)).ok).toBe(true);
  });

  it('runs async validators and handles missing/failed validators', async () => {
    const validator = vi.fn(async () => err(new ValidationError('remote failed')));
    const failed = await validateValue('123', [{ type: 'custom', validatorId: 'phone' }], {
      field: 'phone',
      validators: { phone: validator },
    });
    expect(validator).toHaveBeenCalledOnce();
    expect(failed.valid).toBe(false);
    const missing = await validateValue('123', [{ type: 'custom', validatorId: 'missing' }]);
    expect(missing.errors[0]?.message).toContain('未找到校验器');
    const customMessage = await validateValue(
      '123',
      [{ type: 'custom', validatorId: 'phone', message: '手机号无效' }],
      {
        field: 'phone',
        validators: { phone: () => err(new ValidationError('remote failed')) },
      },
    );
    expect(customMessage.errors[0]?.message).toBe('手机号无效');
    const engine = await validateValue('123', [{ type: 'custom', validatorId: 'phone' }], {
      field: 'phone',
      validators: {
        phone: () => {
          throw new Error('network');
        },
      },
    });
    expect(engine.errors[0]).toBeInstanceOf(ValidationError);
  });

  it('cancels validators through AbortController', async () => {
    const external = new AbortController();
    const validator = vi.fn(async (_value: unknown, context: { readonly signal: AbortSignal }) => {
      external.abort();
      return context.signal.aborted ? err(new ValidationError('cancelled')) : ok(undefined);
    });
    const result = await validateValue('x', [{ type: 'custom', validatorId: 'remote' }], {
      validators: { remote: validator },
      signal: external.signal,
    });
    expect(result.cancelled).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('follows external abort signals with a combined controller', () => {
    const external = new AbortController();
    const combined = createCombinedController(external.signal);
    expect(combined.signal.aborted).toBe(false);
    external.abort('cancel');
    expect(combined.signal.aborted).toBe(true);
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    expect(createCombinedController(alreadyAborted.signal).signal.aborted).toBe(true);
    const internal = new AbortController();
    const internalCombined = combineSignals(undefined, internal.signal);
    expect(internalCombined.aborted).toBe(false);
    internal.abort('internal');
    expect(internalCombined.aborted).toBe(true);
    const externalCombined = combineSignals(external.signal, new AbortController().signal);
    expect(externalCombined.aborted).toBe(true);
    const both = combineSignals(undefined, new AbortController().signal);
    expect(both.aborted).toBe(false);

    const initialInternal = new AbortController();
    initialInternal.abort('initial internal');
    expect(combineSignals(undefined, initialInternal.signal).aborted).toBe(true);

    const initialExternal = new AbortController();
    initialExternal.abort('initial external');
    expect(combineSignals(initialExternal.signal, new AbortController().signal).aborted).toBe(true);

    const cleanupExternal = new AbortController();
    const cleanupInternal = new AbortController();
    const cleaned = combineSignals(cleanupExternal.signal, cleanupInternal.signal);
    cleanupInternal.abort('cleanup');
    expect(cleaned.aborted).toBe(true);
    cleanupExternal.abort('after cleanup');

    const manuallyAborted = createCombinedController(new AbortController().signal);
    manuallyAborted.abort('manual');
    expect(manuallyAborted.signal.aborted).toBe(true);
    expect(createCombinedController().signal.aborted).toBe(false);
  });

  it('handles direct validator success, abort and engine failures', async () => {
    const controller = new AbortController();
    const context = { field: 'field', values: {}, signal: controller.signal };
    expect((await runValidator(() => ok(undefined), 'value', context)).ok).toBe(true);
    controller.abort();
    const aborted = await runValidator(() => ok(undefined), 'value', context);
    expect(isErr(aborted) && aborted.error).toBeInstanceOf(AbortError);
    const active = new AbortController();
    const activeContext = { field: 'field', values: {}, signal: active.signal };
    const abortedAfter = await runValidator(
      (_value: unknown, _current) => {
        active.abort();
        return ok(undefined);
      },
      'value',
      { ...activeContext },
    );
    expect(isErr(abortedAfter) && abortedAfter.error).toBeInstanceOf(AbortError);
    const thrown = await runValidator(
      () => {
        throw new Error('failure');
      },
      'value',
      { field: 'field', values: {}, signal: new AbortController().signal },
    );
    expect(isErr(thrown) && thrown.error).toBeInstanceOf(ValidationEngineError);
    const abortThrowController = new AbortController();
    const abortThrown = await runValidator(
      () => {
        abortThrowController.abort();
        throw new Error('cancelled');
      },
      'value',
      { field: 'field', values: {}, signal: abortThrowController.signal },
    );
    expect(isErr(abortThrown) && abortThrown.error).toBeInstanceOf(AbortError);

    const engineError = new ValidationEngineError('engine failure');
    const returnedEngineError = await runValidator(
      (() => err(engineError)) as unknown as Validator,
      'value',
      {
        field: 'field',
        values: {},
        signal: new AbortController().signal,
      },
    );
    expect(isErr(returnedEngineError) && returnedEngineError.error).toBe(engineError);

    const lateAbortController = new AbortController();
    const lateAbort = await runValidator(
      () => {
        queueMicrotask(() => lateAbortController.abort('late'));
        return ok(undefined);
      },
      'value',
      { field: 'field', values: {}, signal: lateAbortController.signal },
    );
    expect(isErr(lateAbort) && lateAbort.error).toBeInstanceOf(AbortError);
  });

  it('cancels a validator that never settles even when it ignores signal', async () => {
    const controller = new AbortController();
    let release: (() => void) | undefined;
    const pending = new Promise<Result<void, ValidationError>>((resolve) => {
      release = () => resolve(ok(undefined));
    });
    const running = runValidator(() => pending, 'value', {
      field: 'field',
      values: {},
      signal: controller.signal,
    });

    controller.abort('stop');
    const result = await running;
    expect(isErr(result) && result.error).toBeInstanceOf(AbortError);
    // 释放底层 Promise，避免测试结束后留下未决任务；runValidator 已经及时返回。
    release?.();
  });

  it('在微任务启动前取消时不会调用校验器', async () => {
    const controller = new AbortController();
    const validator = vi.fn(() => ok(undefined));
    const pending = runValidator(validator, 'value', {
      field: 'field',
      values: {},
      signal: controller.signal,
    });
    controller.abort('before start');
    const result = await pending;
    expect(validator).not.toHaveBeenCalled();
    expect(isErr(result) && result.error).toBeInstanceOf(AbortError);
  });

  it('returns cancelled for an already aborted value validation', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await validateValue('x', [{ type: 'required' }], { signal: controller.signal });
    expect(result.cancelled).toBe(true);
    expect(validateValueSync('', [{ type: 'required' }], 'field').ok).toBe(false);
    expect(validateValueSync('', [{ type: 'custom', validatorId: 'custom' }]).ok).toBe(true);
  });

  it('normalizes malformed custom validator results and unknown errors', async () => {
    const context = { field: 'field', values: {}, signal: new AbortController().signal };
    const malformed = (() => undefined) as unknown as Validator;
    const malformedResult = await runValidator(malformed, 'value', context);
    expect(isErr(malformedResult) && malformedResult.error).toBeInstanceOf(ValidationEngineError);

    const unknownError = (() => err('remote failure')) as unknown as Validator;
    const unknownResult = await runValidator(unknownError, 'value', context);
    expect(isErr(unknownResult) && unknownResult.error).toBeInstanceOf(ValidationEngineError);
    const validation = await validateValue('value', [{ type: 'custom', validatorId: 'remote' }], {
      validators: { remote: unknownError },
    });
    expect(validation.valid).toBe(false);
    expect(validation.errors[0]).toBeInstanceOf(ValidationError);
  });

  it('fails closed for inherited or throwing validator registry entries', async () => {
    const inherited = await validateValue('value', [{ type: 'custom', validatorId: 'toString' }], {
      validators: Object.create({ toString: () => ok(undefined) }) as Record<string, Validator>,
    });
    expect(inherited.errors[0]?.message).toContain('未找到校验器');

    const throwingRegistry = new Proxy(
      {},
      {
        get() {
          throw new Error('registry getter');
        },
        getOwnPropertyDescriptor() {
          throw new Error('registry descriptor');
        },
        has() {
          throw new Error('registry has');
        },
      },
    ) as Record<string, Validator>;
    const failed = await validateValue('value', [{ type: 'custom', validatorId: 'remote' }], {
      validators: throwingRegistry,
    });
    expect(failed.errors[0]).toBeInstanceOf(ValidationError);
  });
});
