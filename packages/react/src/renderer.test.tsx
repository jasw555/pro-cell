/** @vitest-environment jsdom */
import '@ant-design/v5-patch-for-react-19';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode, type ReactElement } from 'react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { SchemaNode } from '@jasw/pro-cell-shared';
import { createForm } from './formStore';
import { createComponentRegistry, registerComponent } from './registry';
import { SchemaForm, useForm, useFormContext } from './renderer';

describe('SchemaForm renderer', () => {
  afterEach(() => {
    cleanup();
  });

  beforeAll(() => {
    Object.defineProperty(window, 'matchMedia', {
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

  it('渲染内置 Input、映射 onChange 并保留联动可见性', async () => {
    const schema = {
      $comp: 'Fragment',
      children: [
        { $comp: 'Input', name: 'switcher', props: { label: '开关字段' } },
        {
          $comp: 'Input',
          name: 'target',
          props: { label: '目标字段' },
          reactions: [
            {
              when: "{{$deps.switcher === 'on'}}",
              then: { setVisible: true },
              else: { setVisible: false },
            },
          ],
        },
      ],
    } as unknown as SchemaNode;
    const form = createForm({ schema, initialValues: { switcher: 'off' } });
    render(<SchemaForm schema={schema} form={form} />);
    expect(screen.getByDisplayValue('off')).toBeTruthy();
    expect(screen.getAllByRole('textbox')).toHaveLength(1);
    fireEvent.change(screen.getByDisplayValue('off'), { target: { value: 'on' } });
    await waitFor(() => expect(form.getValue('switcher')).toBe('on'));
    await waitFor(() => expect(screen.getAllByRole('textbox')).toHaveLength(2));
  });

  it('支持用户注册组件和自定义值/事件适配器', async () => {
    function CustomSelect(props: Record<string, unknown>): ReactElement {
      const value = typeof props.value === 'string' ? props.value : '';
      const onChange = props.onChange;
      return (
        <button
          type="button"
          aria-label="自定义选择器"
          disabled={props.disabled === true}
          onClick={() => {
            if (typeof onChange === 'function') onChange('selected');
          }}
        >
          {value || 'empty'}
        </button>
      );
    }
    registerComponent('TestSelect', CustomSelect, {
      override: true,
      valueProp: 'value',
      eventToValue: (event: unknown) => event,
    });
    const schema = {
      $comp: 'TestSelect',
      name: 'selection',
    } as unknown as SchemaNode;
    const form = createForm({ schema });
    render(<SchemaForm schema={schema} form={form} />);
    fireEvent.click(screen.getByLabelText('自定义选择器'));
    await waitFor(() => expect(form.getValue('selection')).toBe('selected'));
  });

  it('自定义空注册表保持只读，同时缺失组件回退到内置 Input', async () => {
    const registry = createComponentRegistry();
    const schema = { $comp: 'Input', name: 'title' } as unknown as SchemaNode;
    const form = createForm({ schema, registry, initialValues: { title: 'before' } });

    expect(registry.entries()).toHaveLength(0);
    render(<SchemaForm schema={schema} form={form} />);

    // 内置组件来自渲染器的只读 fallback；render 前后都不会向调用方的注册表补写条目。
    expect(screen.getByDisplayValue('before')).toBeTruthy();
    expect(registry.entries()).toHaveLength(0);
    fireEvent.change(screen.getByDisplayValue('before'), { target: { value: 'after' } });
    await waitFor(() => expect(form.getValue('title')).toBe('after'));
    expect(registry.entries()).toHaveLength(0);
  });

  it('自定义注册表中的同名组件优先于内置 fallback', () => {
    function CustomInput(props: Record<string, unknown>): ReactElement {
      return <output data-testid="custom-input">{String(props.value ?? '')}</output>;
    }
    const registry = createComponentRegistry();
    expect(registry.registerComponent('Input', CustomInput).ok).toBe(true);
    const schema = { $comp: 'Input', name: 'title' } as unknown as SchemaNode;
    const form = createForm({ schema, registry, initialValues: { title: 'custom' } });

    render(<SchemaForm schema={schema} form={form} />);

    expect(screen.getByTestId('custom-input').textContent).toBe('custom');
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(registry.entries()).toHaveLength(1);
  });

  it('无 name 的多层布局节点不订阅表单快照', () => {
    const schema = {
      $comp: 'Fragment',
      children: [
        {
          $comp: 'Fragment',
          children: [{ $comp: 'Input', name: 'onlyField' }],
        },
      ],
    } as unknown as SchemaNode;
    const form = createForm({ schema });
    const nativeSubscribe = form.subscribeSnapshot;
    if (nativeSubscribe === undefined) throw new Error('内置 FormApi 应提供快照订阅');
    let subscriptions = 0;
    const observedForm = {
      ...form,
      subscribeSnapshot: (listener: () => void) => {
        subscriptions += 1;
        return nativeSubscribe.call(form, listener);
      },
    };

    render(<SchemaForm schema={schema} form={observedForm} />);

    // 两层 Fragment 都是纯布局，唯一一次订阅只属于命名字段 onlyField。
    expect(subscriptions).toBe(1);
    expect(screen.getByRole('textbox')).toBeTruthy();
  });

  it('字段快照保持引用稳定，更新其它字段不会触发无关组件重渲染', () => {
    const renders: Record<string, number> = { first: 0, second: 0 };
    function ProbeField(props: Record<string, unknown>): ReactElement {
      const id = typeof props.id === 'string' ? props.id : 'unknown';
      renders[id] = (renders[id] ?? 0) + 1;
      return <span data-testid={id}>{String(props.value ?? '')}</span>;
    }
    const registry = createComponentRegistry();
    const registered = registry.registerComponent('ProbeField', ProbeField);
    expect(registered.ok).toBe(true);
    const schema = {
      $comp: 'Fragment',
      children: [
        { $comp: 'ProbeField', name: 'first' },
        { $comp: 'ProbeField', name: 'second' },
      ],
    } as unknown as SchemaNode;
    const form = createForm({ schema, registry, initialValues: { first: 'a', second: 'b' } });

    render(<SchemaForm schema={schema} form={form} />);
    expect(renders).toEqual({ first: 1, second: 1 });

    act(() => {
      expect(form.setValue('second', 'next').ok).toBe(true);
    });
    expect(screen.getByTestId('second').textContent).toBe('next');
    expect(renders).toEqual({ first: 1, second: 2 });
    // Fragment fallback 同样不会被写入只有 ProbeField 的用户注册表。
    expect(registry.entries()).toHaveLength(1);
  });

  it('React 19 StrictMode 重放 effect 时不会提前销毁内部表单', async () => {
    let form: ReturnType<typeof useForm> | undefined;
    const schema = { $comp: 'Input', name: 'value' } as unknown as SchemaNode;
    function Host(): ReactElement {
      const currentForm = useForm({ schema });
      form = currentForm;
      return <SchemaForm schema={schema} form={currentForm} />;
    }

    render(
      <StrictMode>
        <Host />
      </StrictMode>,
    );
    // StrictMode 的 effect replay 紧挨着首次 setup，但真实卸载与 replay 的时间
    // 间隔可能受调度影响；等待 100ms 能覆盖“延迟销毁”实现的完整窗口。
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    });
    expect(form?.setValue('value', 'alive').ok).toBe(true);
    expect(form?.getValue('value')).toBe('alive');
  });

  it('React 19 StrictMode 下 SchemaForm 自建表单在 100ms 后仍可写入', async () => {
    let form: ReturnType<typeof useFormContext> | undefined;
    const schema = { $comp: 'Fragment' } as unknown as SchemaNode;

    function CaptureForm(): ReactElement {
      form = useFormContext();
      return <span data-testid="form-context-capture" />;
    }

    render(
      <StrictMode>
        <SchemaForm schema={schema} options={{ initialValues: { value: 'initial' } }}>
          <CaptureForm />
        </SchemaForm>
      </StrictMode>,
    );
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    });
    expect(form).toBeDefined();
    expect(form?.setValue('value', 'alive').ok).toBe(true);
    expect(form?.getValue('value')).toBe('alive');
  });
});
