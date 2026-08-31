/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Component, createElement, type ErrorInfo, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ComponentNotFoundError,
  ReactionExecutionError,
  SchemaParseError,
  type SchemaNode,
} from '@jasw/pro-cell-shared';
import { createForm } from './formStore';
import { FormContext, SchemaForm, SchemaRenderer, useForm, useFormContext } from './renderer';
import type { ComponentRegistryLike, FieldState, FormApi, RegisteredComponent } from './types';

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function expectInvalidSchema(schema: SchemaNode | string): void {
  expect(() => render(<SchemaRenderer schema={schema} />)).toThrow(SchemaParseError);
}

function EventButton(props: Record<string, unknown>): ReactElement {
  const onChange = props.onChange;
  return (
    <button
      id={typeof props.id === 'string' ? props.id : undefined}
      type="button"
      disabled={props.disabled === true}
      onClick={() => {
        if (typeof onChange === 'function') onChange('raw', 'metadata');
      }}
    >
      {String(props.modelValue ?? props.value ?? 'empty')}
    </button>
  );
}

function EagerChange(props: Record<string, unknown>): ReactElement {
  const onChange = props.onChange;
  if (typeof onChange === 'function') onChange('raw');
  return createElement('span');
}

class TestErrorBoundary extends Component<
  { readonly children: ReactNode; readonly onError: (error: Error) => void },
  { readonly failed: boolean }
> {
  public override state = { failed: false };

  public static getDerivedStateFromError(): { readonly failed: boolean } {
    return { failed: true };
  }

  public override componentDidCatch(error: Error, _info: ErrorInfo): void {
    this.props.onError(error);
  }

  public override render(): ReactNode {
    return this.state.failed ? createElement('span', null, 'captured') : this.props.children;
  }
}

function createSingleEntryRegistry(entry: RegisteredComponent): ComponentRegistryLike {
  return {
    get: (name: string) => (name === 'EventButton' ? entry : undefined),
  };
}

function overrideFieldState(
  form: FormApi,
  patch: Partial<FieldState>,
  registry?: ComponentRegistryLike,
): FormApi {
  return {
    ...form,
    getFieldState: (path: string) => ({ ...form.getFieldState(path), ...patch }),
    ...(registry === undefined ? {} : { getRegistry: () => registry }),
  };
}

describe('SchemaRenderer 输入边界', () => {
  it('支持 JSON 字符串，并展示 required 校验错误', async () => {
    const schema = JSON.stringify({
      $comp: 'Input',
      name: 'title',
      props: { label: '标题' },
      rules: [{ type: 'required', message: '请输入标题' }],
    });
    const form = createForm({ schema });

    render(<SchemaRenderer schema={schema} form={form} />);
    await act(async () => {
      await form.validateField('title');
    });

    expect(screen.getByLabelText('标题')).toBeTruthy();
    expect(screen.getByText('请输入标题')).toBeTruthy();
  });

  it('拒绝损坏 JSON、空字段名以及无名称的规则/联动节点', () => {
    expectInvalidSchema('{');
    expectInvalidSchema({ $comp: 'Input', name: '   ' });
    expectInvalidSchema({
      $comp: 'Input',
      rules: [{ type: 'required' }],
    });
    expectInvalidSchema({
      $comp: 'Fragment',
      children: [
        {
          $comp: 'Input',
          reactions: [{ when: '{{$deps.source === true}}', then: { setVisible: true } }],
        },
      ],
    });
  });

  it('把读取异常的 Schema 作为解析错误处理', () => {
    const schema = Object.defineProperty({}, '$comp', {
      enumerable: true,
      get: () => {
        throw new Error('schema getter failure');
      },
    }) as SchemaNode;

    expectInvalidSchema(schema);
  });

  it('支持 ReactNode 数组标签，并忽略不可渲染的普通对象标签', () => {
    const schema = {
      $comp: 'Fragment',
      children: [
        {
          $comp: 'Input',
          name: 'renderable',
          props: {
            label: [createElement('span', { key: 'name' }, '姓名'), ['：', 1]],
          },
        },
        {
          $comp: 'Input',
          name: 'ignored',
          props: { label: { unsafe: true } },
        },
      ],
    } as unknown as SchemaNode;
    const form = createForm({ schema });

    render(<SchemaRenderer schema={schema} form={form} />);

    expect(screen.getByText('姓名')).toBeTruthy();
    expect(
      screen.getByText((_, element) =>
        element?.tagName === 'LABEL' ? element.textContent === '姓名：1' : false,
      ),
    ).toBeTruthy();
    expect(screen.queryByText('[object Object]')).toBeNull();
  });

  it('对未知组件和注册表读取异常抛出明确领域错误', () => {
    const missingSchema = { $comp: 'MissingComponent' } as SchemaNode;
    expect(() => render(<SchemaRenderer schema={missingSchema} />)).toThrow(ComponentNotFoundError);

    const brokenRegistry: ComponentRegistryLike = {
      get: () => {
        throw new Error('registry failure');
      },
    };
    const form = createForm({
      schema: { $comp: 'Input', name: 'field' },
      registry: brokenRegistry,
    });
    expect(() =>
      render(<SchemaRenderer schema={{ $comp: 'Input', name: 'field' }} form={form} />),
    ).toThrow(ReactionExecutionError);
  });
});

describe('SchemaRenderer 字段适配', () => {
  it('兼容未提供 subscribeSnapshot/getRegistry 的基础 FormApi', () => {
    const schema = { $comp: 'Input', name: 'legacy' } as SchemaNode;
    const nativeForm = createForm({ schema, initialValues: { legacy: 'before' } });
    const legacyForm = { ...nativeForm } as FormApi;
    delete (legacyForm as { subscribeSnapshot?: FormApi['subscribeSnapshot'] }).subscribeSnapshot;
    delete (legacyForm as { getRegistry?: FormApi['getRegistry'] }).getRegistry;

    render(<SchemaRenderer schema={schema} form={legacyForm} />);
    expect(screen.getByDisplayValue('before')).toBeTruthy();

    act(() => {
      expect(nativeForm.setDisabled('legacy', true).ok).toBe(true);
    });
    expect((screen.getByRole('textbox') as HTMLInputElement).disabled).toBe(true);
  });

  it('使用默认 changeProp、保留用户回调并提交适配后的值', async () => {
    const userOnChange = vi.fn();
    const entry: RegisteredComponent = {
      component: EventButton,
      valueProp: 'modelValue',
      eventToValue: (event: unknown) => `${String(event)}-adapted`,
    };
    const registry = createSingleEntryRegistry(entry);
    const schema = {
      $comp: 'EventButton',
      name: 'choice',
      props: { id: 'explicit-id', onChange: userOnChange },
    } as unknown as SchemaNode;
    const form = createForm({ schema, registry, initialValues: { choice: 'before' } });

    render(<SchemaRenderer schema={schema} form={form} />);
    const button = screen.getByRole('button') as HTMLButtonElement;
    expect(button.id).toBe('explicit-id');
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    await waitFor(() => expect(form.getValue('choice')).toBe('raw-adapted'));
    expect(userOnChange).toHaveBeenCalledWith('raw', 'metadata');
  });

  it('把事件适配器的未知异常封装为 ReactionExecutionError', () => {
    const entry: RegisteredComponent = {
      component: EagerChange,
      valueProp: 'value',
      changeProp: 'onChange',
      eventToValue: () => {
        throw new Error('adapter failure');
      },
    };
    const registry = createSingleEntryRegistry(entry);
    const schema = { $comp: 'EventButton', name: 'choice' } as SchemaNode;
    const form = createForm({ schema, registry });
    expect(() => render(<SchemaRenderer schema={schema} form={form} />)).toThrow(
      ReactionExecutionError,
    );
  });

  it('不重复封装事件边界中已有的 ProCellError', () => {
    const expected = new SchemaParseError('known error');
    const entry: RegisteredComponent = {
      component: EagerChange,
      valueProp: 'value',
      changeProp: 'onChange',
      eventToValue: () => {
        throw expected;
      },
    };
    const registry = createSingleEntryRegistry(entry);
    const schema = { $comp: 'EventButton', name: 'choice' } as SchemaNode;
    const form = createForm({ schema, registry });
    expect(() => render(<SchemaRenderer schema={schema} form={form} />)).toThrow(expected);
  });

  it('把 FormApi 更新失败作为事件错误向上抛出', () => {
    const entry: RegisteredComponent = {
      component: EagerChange,
      valueProp: 'value',
      changeProp: 'onChange',
      eventToValue: (event: unknown) => event,
    };
    const registry = createSingleEntryRegistry(entry);
    const schema = { $comp: 'EventButton', name: 'choice' } as SchemaNode;
    const form = createForm({ schema, registry });
    form.dispose();

    expect(() => render(<SchemaRenderer schema={schema} form={form} />)).toThrow('表单实例已销毁');
  });

  it('把 validating 状态映射到 Form.Item', () => {
    const schema = {
      $comp: 'Input',
      name: 'pending',
      props: { label: 101, disabled: true },
    } as SchemaNode;
    const nativeForm = createForm({ schema });
    const form = overrideFieldState(nativeForm, { validating: true });
    const { container } = render(<SchemaRenderer schema={schema} form={form} />);

    expect(screen.getByText('101')).toBeTruthy();
    expect((screen.getByRole('textbox') as HTMLInputElement).disabled).toBe(true);
    expect(container.querySelector('.ant-form-item-is-validating')).not.toBeNull();
  });
});

describe('React 表单生命周期与上下文', () => {
  it('SchemaRenderer 可独立创建本地表单，也可读取 FormContext', () => {
    const localSchema = { $comp: 'Input', name: 'local' } as SchemaNode;
    const localView = render(<SchemaRenderer schema={localSchema} className="local-renderer" />);
    expect(localView.container.querySelector('.local-renderer')).not.toBeNull();
    localView.unmount();

    const contextSchema = { $comp: 'Input', name: 'context' } as SchemaNode;
    const contextForm = createForm({ schema: contextSchema, initialValues: { context: 'value' } });
    render(
      <FormContext.Provider value={contextForm}>
        <SchemaRenderer schema={contextSchema} />
      </FormContext.Provider>,
    );
    expect(screen.getByDisplayValue('value')).toBeTruthy();
  });

  it('SchemaForm 自建表单时接收 onSubmit 和 className', () => {
    const schema = { $comp: 'Input', name: 'owned' } as SchemaNode;
    const optionSubmit = vi.fn();
    const explicitSubmit = vi.fn();

    const first = render(
      <SchemaForm schema={schema} className="owned-form" options={{ onSubmit: optionSubmit }} />,
    );
    expect(first.container.querySelector('.owned-form')).not.toBeNull();
    first.unmount();

    render(
      <SchemaForm
        schema={schema}
        className="overridden-form"
        options={{ onSubmit: optionSubmit }}
        onSubmit={explicitSubmit}
      />,
    );
    expect(document.querySelector('.overridden-form')).not.toBeNull();
  });

  it('在 queueMicrotask 不可用时仍会于卸载后销毁 useForm 实例', async () => {
    const originalQueueMicrotask = globalThis.queueMicrotask;
    vi.stubGlobal('queueMicrotask', undefined);
    let captured: FormApi | undefined;

    function Host(): ReactElement {
      captured = useForm();
      return createElement('span');
    }

    const view = render(<Host />);
    view.unmount();
    vi.stubGlobal('queueMicrotask', originalQueueMicrotask);
    await Promise.resolve();
    await Promise.resolve();

    expect(captured).toBeDefined();
    expect(captured?.setValue('field', 'value').ok).toBe(false);
  });

  it('useFormContext 在 Provider 外给出明确错误', () => {
    // React 会把 ErrorBoundary 捕获的异常写到 stderr；该行为已由 onError 断言覆盖。
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    function Consumer(): ReactElement {
      useFormContext();
      return createElement('span');
    }
    const onError = vi.fn();
    render(
      <TestErrorBoundary onError={onError}>
        <Consumer />
      </TestErrorBoundary>,
    );
    expect(screen.getByText('captured')).toBeTruthy();
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0]?.[0] as Error).message).toBe(
      'useFormContext 必须在 SchemaForm 内使用',
    );
  });
});
