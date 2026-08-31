import { describe, expect, it } from 'vitest';
import {
  AbortError,
  ComponentNotFoundError,
  DependencyCycleError,
  ExpressionError,
  FormSubmitError,
  ProCellError,
  ReactionExecutionError,
  RegistryError,
  SchemaParseError,
  ValidationEngineError,
  ValidationError,
  getPathValue,
  isJsonRecord,
  isReactionActions,
  isReactionConfig,
  isSchemaNode,
  isValidationRuleConfig,
  normalizePath,
  normalizeSchemaNode,
  setPathValue,
  splitPath,
  toError,
} from './index';
import type { SchemaNode } from './index';

describe('schema and path utilities', () => {
  it('validates schema records and every rule variant', () => {
    expect(isJsonRecord({})).toBe(true);
    expect(isJsonRecord(null)).toBe(false);
    expect(isJsonRecord([])).toBe(false);
    expect(isSchemaNode(null)).toBe(false);
    expect(isSchemaNode({ $comp: 'Input' })).toBe(true);
    expect(isSchemaNode({ $comp: '' })).toBe(false);
    expect(isSchemaNode({ $comp: '   ' })).toBe(false);
    expect(isSchemaNode(Object.create({ $comp: 'Input' }))).toBe(false);
    expect(isSchemaNode({ $comp: 'Input', name: 1 })).toBe(false);
    expect(isSchemaNode({ $comp: 'Input', props: [] })).toBe(false);
    expect(isSchemaNode({ $comp: 'Input', children: [{}] })).toBe(false);
    expect(isSchemaNode({ $comp: 'Input', rules: [{ type: 'required' }] })).toBe(true);
    expect(isSchemaNode({ $comp: 'Input', reactions: [{ when: 'true', then: {} }] })).toBe(true);
    expect(
      isSchemaNode({ $comp: 'Input', reactions: [{ when: 'true', then: { setVisible: 1 } }] }),
    ).toBe(false);
    expect(isSchemaNode({ $comp: 'Input', rules: null })).toBe(false);
    expect(isSchemaNode({ $comp: 'Input', reactions: null })).toBe(false);
    expect(() => normalizeSchemaNode({} as unknown as SchemaNode)).toThrow(SchemaParseError);

    const cyclic: { $comp: string; children: unknown[] } = {
      $comp: 'Fragment',
      children: [],
    };
    cyclic.children.push(cyclic);
    expect(isSchemaNode(cyclic)).toBe(false);
    expect(() => normalizeSchemaNode(cyclic as never)).toThrow(SchemaParseError);
    const hostile = new Proxy(
      { $comp: 'Input' },
      {
        get: () => {
          throw new Error('getter');
        },
      },
    );
    expect(isSchemaNode(hostile)).toBe(false);
    const hostileRule = new Proxy(
      { type: 'required' },
      {
        get: () => {
          throw new Error('rule getter');
        },
      },
    );
    expect(isValidationRuleConfig(hostileRule)).toBe(false);
    const hostileActions = new Proxy(
      {},
      {
        get: () => {
          throw new Error('action getter');
        },
      },
    );
    expect(isReactionActions(hostileActions)).toBe(false);
    const hostileReaction = new Proxy(
      { when: 'true', then: {} },
      {
        get: () => {
          throw new Error('reaction getter');
        },
      },
    );
    expect(isReactionConfig(hostileReaction)).toBe(false);

    expect(isValidationRuleConfig({ type: 'required', message: 'required' })).toBe(true);
    expect(isValidationRuleConfig({ type: 'maxLength', value: 2 })).toBe(true);
    expect(isValidationRuleConfig({ type: 'maxLength', value: -1 })).toBe(false);
    expect(isValidationRuleConfig({ type: 'pattern', value: '^x', flags: 'i' })).toBe(true);
    expect(isValidationRuleConfig({ type: 'custom', validatorId: 'remote' })).toBe(true);
    expect(isValidationRuleConfig({ type: 'custom', validatorId: '' })).toBe(false);
    expect(isValidationRuleConfig({ type: 'unknown' })).toBe(false);
    expect(isValidationRuleConfig(null)).toBe(false);
    expect(isReactionActions({ setValue: { value: 1 } })).toBe(true);
    expect(isReactionActions(null)).toBe(false);
    expect(isReactionActions({ setDisabled: null })).toBe(false);
    expect(isReactionConfig({ when: 'true', then: {}, else: { setVisible: false } })).toBe(true);
    expect(isReactionConfig({ when: 1, then: {} })).toBe(false);
  });

  it('normalizes immutable trees and reads/writes flat and nested paths', () => {
    const schema = normalizeSchemaNode({
      $comp: 'Fragment',
      props: { role: 'group' },
      children: [{ $comp: 'Input', name: 'child' }],
    });
    expect(Object.isFrozen(schema)).toBe(true);
    expect(Object.isFrozen(schema.props)).toBe(true);
    expect(schema.children[0]?.$comp).toBe('Input');
    expect(splitPath('user..phone.')).toEqual(['user', 'phone']);
    expect(normalizePath('user..phone.')).toBe('user.phone');
    const nested = setPathValue({}, 'user.phone', '123');
    expect(getPathValue(nested, 'user.phone')).toBe('123');
    const flatUpdated = setPathValue({ 'user.phone': 'old' }, 'user.phone', 'new');
    expect(getPathValue(flatUpdated, 'user.phone')).toBe('new');
    const existingNested = setPathValue({ user: { name: 'A' } }, 'user.phone', '123');
    expect(getPathValue(existingNested, 'user.name')).toBe('A');
    expect(getPathValue({ 'user.phone': 'flat' }, 'user.phone')).toBe('flat');
    expect(getPathValue({ user: null }, 'user.phone')).toBeUndefined();
    expect(getPathValue({}, 'constructor')).toBeUndefined();
    expect(getPathValue({}, '__proto__.polluted')).toBeUndefined();
    expect(getPathValue({}, '')).toBeUndefined();
    const inheritedGetterPrototype = {};
    Object.defineProperty(inheritedGetterPrototype, 'secret', {
      configurable: true,
      get: () => {
        throw new Error('inherited getter must not run');
      },
    });
    expect(getPathValue(Object.create(inheritedGetterPrototype), 'secret')).toBeUndefined();
    expect(setPathValue({}, '__proto__.polluted', true)).toEqual({});
    expect(setPathValue({ a: 1 }, '', 2)).toEqual({ '': 2, a: 1 });

    const source = {
      $comp: 'Input',
      props: { options: [{ label: '原始', value: 1 }] },
      rules: [{ type: 'required', message: '必填' }],
      reactions: [{ when: 'true', then: { setValue: { nested: true } } }],
    } as const;
    const normalized = normalizeSchemaNode(source);
    const normalizedOptions = normalized.props.options as readonly {
      readonly label: string;
      readonly value: number;
    }[];
    expect(normalized.props).not.toBe(source.props);
    expect(normalized.props.options).not.toBe(source.props.options);
    expect(Object.isFrozen(normalizedOptions)).toBe(true);
    expect(Object.isFrozen(normalizedOptions[0])).toBe(true);
    expect(Object.isFrozen(normalized.rules)).toBe(true);
    expect(Object.isFrozen(normalized.rules[0])).toBe(true);
    expect(Object.isFrozen(normalized.reactions[0])).toBe(true);
    expect(Object.isFrozen(normalized.reactions[0]?.then)).toBe(true);
    Reflect.set(source.props.options[0], 'label', '修改原始');
    expect(normalizedOptions[0]?.label).toBe('原始');

    const cyclicProps: { self?: unknown } = {};
    cyclicProps.self = cyclicProps;
    expect(() =>
      normalizeSchemaNode({ $comp: 'Input', props: cyclicProps } as unknown as SchemaNode),
    ).toThrow(SchemaParseError);
    const hostileProps = new Proxy(
      { value: 1 },
      {
        get: () => {
          throw new Error('props getter');
        },
      },
    );
    expect(() =>
      normalizeSchemaNode({ $comp: 'Input', props: hostileProps } as unknown as SchemaNode),
    ).toThrow(SchemaParseError);
  });
});

describe('领域错误', () => {
  it('preserves codes, names, causes and details', () => {
    const cause = new Error('cause');
    const errors: readonly ProCellError[] = [
      new SchemaParseError('schema', cause),
      new ComponentNotFoundError('Input', 'form.name'),
      new ComponentNotFoundError('Input'),
      new RegistryError('registry', cause),
      new ExpressionError('expr', 'expression', 2, cause),
      new DependencyCycleError(['A', 'B', 'A']),
      new ReactionExecutionError('reaction', 'field', cause),
      new ValidationError('validation', { field: 'field', rule: 'required', cause }),
      new ValidationEngineError('engine', cause),
      new FormSubmitError('submit', cause),
      new AbortError('abort', cause),
    ];
    expect(errors.map((error) => error.code)).toEqual([
      'SCHEMA_PARSE_ERROR',
      'COMPONENT_NOT_FOUND',
      'COMPONENT_NOT_FOUND',
      'REGISTRY_ERROR',
      'EXPRESSION_ERROR',
      'DEPENDENCY_CYCLE',
      'REACTION_EXECUTION_ERROR',
      'VALIDATION_ERROR',
      'VALIDATION_ENGINE_ERROR',
      'FORM_SUBMIT_ERROR',
      'ABORT_ERROR',
    ]);
    expect(errors[4]?.name).toBe('ExpressionError');
    expect(errors[5]).toMatchObject({ cycle: ['A', 'B', 'A'] });
    expect(toError(cause)).toBe(cause);
    expect(toError('message').message).toBe('message');
    expect(toError({ value: 1 }).message).toBe('未知错误');
  });
});
