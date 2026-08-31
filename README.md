# @jasw/pro-cell

[![CI](https://github.com/jasw555/pro-cell/actions/workflows/ci.yml/badge.svg)](https://github.com/jasw555/pro-cell/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/jasw555/pro-cell/blob/main/LICENSE)

`@jasw/pro-cell` 是一个面向 React 19 的 Schema 表单/表格渲染器，使用 `$comp` 描述组件树，antd 负责界面，Zustand 负责表单状态。

> 当前版本：`0.1.0`（早期版本，API 仍可能演进）

## 为什么做这个项目

在后台系统和配置平台里，我经常遇到同一类问题：表单结构来自接口，字段之间有不少显隐和赋值联动，但业务代码最后被 `useEffect` 和条件判断切得很碎。Pro Cell 想解决的就是这一段——让结构、联动和校验继续保持为可读、可序列化的 JSON，同时保留 React 组件扩展能力。

目前它提供：

- 用 `$comp` 指定组件，用 `props` 传递组件属性；
- 用 `children` 递归组合页面结构；
- 用 `reactions` 声明字段之间的依赖，而不需要在页面组件中散落大量 `useEffect`；
- 用 `rules` 声明同步或异步校验；
- 用 Zustand vanilla store 为每个表单创建隔离状态；
- 用 `Result<T, E>` 和领域错误类型处理预期失败；
- 所有异步校验和提交都可以通过 `AbortController` 取消。

它不是 JSON Schema Draft 实现，也不打算替代 antd Form。v1 先把表单渲染、字段联动、校验和只读 Table 做扎实。

## 包与导入路径

仓库采用 pnpm workspace + Turborepo，但真正发布到 npm 的只有一个包：

| workspace           | npm 发布                 | 作用                                      |
| ------------------- | ------------------------ | ----------------------------------------- |
| `packages/pro-cell` | **是：`@jasw/pro-cell`** | 聚合入口和多入口构建                      |
| `packages/shared`   | 否，`private: true`      | Result、错误、Schema 类型、路径和校验     |
| `packages/core`     | 否，`private: true`      | SchemaParser、表达式和 DependencyTracker  |
| `packages/react`    | 否，`private: true`      | React Renderer、Zustand FormApi、内置组件 |
| `packages/examples` | 否，`private: true`      | Vite 示例应用                             |

下面四个导入路径仍然属于同一个 `@jasw/pro-cell` 版本，分别映射到同一个 tarball 中的多入口文件：

```ts
import { SchemaForm, createForm, registerComponent } from '@jasw/pro-cell';
import { DependencyTracker } from '@jasw/pro-cell/core';
import { useForm } from '@jasw/pro-cell/react';
import { required, validateValue } from '@jasw/pro-cell/shared';
```

| 导入路径                | 适用场景                                                     |
| ----------------------- | ------------------------------------------------------------ |
| `@jasw/pro-cell`        | React 19 应用的推荐入口：表单 API、默认组件、根 SchemaParser |
| `@jasw/pro-cell/core`   | 不需要 Zustand 表单状态时，使用解析器、表达式和依赖追踪      |
| `@jasw/pro-cell/react`  | 只引入 React Renderer、FormApi 和 React 组件注册表           |
| `@jasw/pro-cell/shared` | 只引入 Result、类型、规则和路径工具                          |

`core` 子路径的 `ComponentRegistry` 是无 UI 状态的独立注册表，根入口的 `ComponentRegistry` 是 React 注册表。跨子路径使用时，请从同一个子路径配对注册表和 `SchemaParser`；普通 React 应用直接使用根入口即可。

构建产物同时提供 ESM 和 CommonJS。现代 Vite/Node 项目直接使用上面的 `import`；CommonJS 项目可以使用同一版本的 `require`，不需要安装第二个包：

```js
const { createForm, SchemaForm } = require('@jasw/pro-cell');
const { DependencyTracker } = require('@jasw/pro-cell/core');
```

TypeScript 类型声明会随四个入口一起发布，编辑器可以直接从对应子路径获得完整类型提示。

## 架构图

下面的图同时展示运行时数据流和发布边界：`shared`、`core`、`react` 只是私有 workspace，最终会被聚合到唯一公开包 `@jasw/pro-cell`；应用只需要安装这一个包及其 peer dependencies。

```mermaid
flowchart LR
  App[React 19 应用] -->|JSON Schema / FormApi| Public[@jasw/pro-cell\n唯一 npm 包]
  Public --> Shared[shared\nResult · Schema · 校验]
  Public --> Core[core\nSchemaParser · DSL · DependencyTracker]
  Public --> ReactLayer[react\nZustand FormApi · Renderer]
  Shared --> Core
  Core --> ReactLayer
  ReactLayer --> Antd[antd 5\nForm.Item · Input · Select · Switch · Table]
  ReactLayer --> Store[(vanilla Zustand store)]
  Core -->|setVisible / setDisabled / setValue| Store
  Store -->|快照订阅| ReactLayer
  Validator[远程校验器] -->|AbortSignal| Shared
  App -->|子路径导入\n/core / /react / /shared| Public

  subgraph Workspace[仓库内部 workspace（均 private）]
    Shared
    Core
    ReactLayer
    Examples[examples\nVite 示例应用]
  end
```

## 安装

运行环境要求：Node.js 20+、React 19.x、React DOM 19.x、antd 5.x 和 Zustand 5.x。

```bash
pnpm add @jasw/pro-cell antd react react-dom zustand @ant-design/v5-patch-for-react-19
```

React 19 使用 antd 5 时，在应用最早的入口文件导入官方兼容补丁。补丁只需要导入一次，Pro Cell 不会自动修改全局环境：

```tsx
// src/main.tsx
import '@ant-design/v5-patch-for-react-19';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

const element = document.getElementById('root');
if (element === null) {
  throw new Error('找不到应用挂载节点');
}

createRoot(element).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

## 5 分钟上手：React 19 示例

### 1. 写一个 JSON Schema

Schema 可以直接来自 JSON 文件、接口响应，或者 TypeScript 对象。下面的示例包含一个账户类型字段，以及根据账户类型显隐并清空企业名称的联动：

```ts
// src/schema.ts
import type { SchemaNode } from '@jasw/pro-cell';

export const accountSchema: SchemaNode = {
  $comp: 'Fragment',
  children: [
    {
      $comp: 'Select',
      name: 'accountType',
      props: {
        label: '账户类型',
        options: [
          { label: '个人', value: 'personal' },
          { label: '企业', value: 'business' },
        ],
      },
    },
    {
      $comp: 'Input',
      name: 'companyName',
      props: { label: '企业名称', placeholder: '企业账户必填' },
      rules: [{ type: 'custom', validatorId: 'companyName' }],
      reactions: [
        {
          when: "{{$deps.accountType === 'business'}}",
          then: { setVisible: true, setDisabled: false },
          else: { setVisible: false, setDisabled: true, setValue: '' },
        },
      ],
    },
  ],
};
```

### 2. 最小渲染方式

没有提交按钮或外部状态需求时，`SchemaForm` 会自动创建并销毁一个独立的表单实例：

```tsx
// src/App.tsx
import type { ReactElement } from 'react';
import { SchemaForm } from '@jasw/pro-cell';
import { accountSchema } from './schema';

export function App(): ReactElement {
  return <SchemaForm schema={accountSchema} />;
}
```

### 3. 带提交按钮、异步校验和取消

需要在页面中访问 FormApi 时，用 `useForm` 创建实例，再把它传给 `SchemaForm`。当传入 `children` 时，`SchemaForm` 不会自动重复渲染 Schema；需要显式放置 `SchemaRenderer`：

```tsx
// src/App.tsx
import { useRef, useState, type ReactElement } from 'react';
import { Button, Space, Typography } from 'antd';
import { err, ok, SchemaForm, SchemaRenderer, useForm, ValidationError } from '@jasw/pro-cell';
import type { ValidatorRegistry } from '@jasw/pro-cell';
import { accountSchema } from './schema';

export function App(): ReactElement {
  const [message, setMessage] = useState('');
  const submitController = useRef<AbortController | null>(null);
  const form = useForm({
    schema: accountSchema,
    initialValues: { accountType: 'personal', companyName: '' },
    validators: {
      companyName: async (value, { values, signal }) => {
        if (values.accountType !== 'business') {
          return ok(undefined);
        }
        const name = String(value ?? '').trim();
        if (name.length === 0) {
          return err(new ValidationError('请填写企业名称'));
        }
        const response = await fetch(`/api/company?q=${encodeURIComponent(name)}`, {
          signal,
        });
        return response.ok ? ok(undefined) : err(new ValidationError('企业名称已被占用'));
      },
    } satisfies ValidatorRegistry,
    onSubmit: async (values, { signal }) => {
      const response = await fetch('/api/accounts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(values),
        signal,
      });
      if (!response.ok) {
        throw new Error(`提交失败（HTTP ${response.status}）`);
      }
      return values;
    },
  });

  const submit = async (): Promise<void> => {
    submitController.current?.abort();
    const controller = new AbortController();
    submitController.current = controller;
    const result = await form.submit({ signal: controller.signal });
    if (result.ok) {
      setMessage('保存成功');
    } else if (result.error.code === 'ABORT_ERROR') {
      setMessage('提交已取消');
    } else {
      setMessage(result.error.message);
    }
  };

  return (
    <SchemaForm schema={accountSchema} form={form}>
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <SchemaRenderer schema={accountSchema} form={form} />
        <Space>
          <Button type="primary" onClick={() => void submit()}>
            保存
          </Button>
          <Button onClick={() => submitController.current?.abort()}>取消</Button>
        </Space>
        {message ? <Typography.Text>{message}</Typography.Text> : null}
      </Space>
    </SchemaForm>
  );
}
```

自定义校验器必须返回 `ok(undefined)` 或 `err(new ValidationError(...))`。上面的校验器先读取 `values.accountType`，因此隐藏的个人账户字段不会被误报为必填。请始终把收到的 `signal` 传递给 `fetch` 或其他可取消的异步 API；Abort 发生时，Pro Cell 会把结果标记为 `cancelled`，不会把取消显示成普通字段错误。

## `$comp` Schema 协议

### 节点字段

```ts
interface SchemaNode {
  readonly $comp: string;
  readonly name?: string;
  readonly props?: Readonly<Record<string, unknown>>;
  readonly children?: readonly SchemaNode[];
  readonly rules?: readonly ValidationRuleConfig[];
  readonly reactions?: readonly ReactionConfig[];
}
```

| 字段        | 说明                                                                                                           |
| ----------- | -------------------------------------------------------------------------------------------------------------- |
| `$comp`     | 必填，注册表中的组件名。内置值为 `Input`、`Select`、`Switch`、`Table`、`Fragment`。                            |
| `name`      | 字段的稳定点号路径，例如 `user.phone`。有 `rules` 或 `reactions` 时必须提供；状态对象使用扁平路径键。          |
| `props`     | 传给组件的静态属性。`label` 会被映射到 antd `Form.Item`，`name`、`rules`、`reactions` 和 `children` 不会透传。 |
| `children`  | 子节点数组，解析器会递归渲染；`Fragment` 用于组合多个节点。                                                    |
| `rules`     | 声明式校验规则，按数组顺序执行并在首个失败处短路。                                                             |
| `reactions` | 依赖字段变化时执行的显隐、禁用和值动作。                                                                       |

字段的“受控绑定”由顶层 `name` 开启。渲染器会依据组件适配器注入 `value`（或 `checked`、`dataSource`）和变更事件。没有 `name` 的节点仍可通过 `props.value` 或 `props.checked` 作为静态展示值；这不会被当作表单绑定。

### children 递归

```json
{
  "$comp": "Fragment",
  "children": [
    {
      "$comp": "Input",
      "name": "profile.firstName",
      "props": { "label": "名" }
    },
    {
      "$comp": "Fragment",
      "children": [
        {
          "$comp": "Input",
          "name": "profile.lastName",
          "props": { "label": "姓" }
        }
      ]
    }
  ]
}
```

解析器只缓存冻结的静态规范化 AST，不缓存包含动态值和路径 key 的 ReactElement。相同对象再次规范化时命中 `WeakMap`；一次完整遍历的复杂度为 O(N)，N 是 Schema 节点数。

### reactions 联动

```json
{
  "$comp": "Input",
  "name": "shippingAddress",
  "props": { "label": "收货地址" },
  "reactions": [
    {
      "when": "{{$deps.sameAs === true}}",
      "then": {
        "setVisible": false,
        "setValue": "{{$deps.billingAddress}}"
      },
      "else": { "setVisible": true }
    }
  ]
}
```

规则约定：

1. `when` 必须是 `{{ ... }}` 形式的安全表达式。
2. `$deps.field` 读取扁平字段路径；编译阶段会自动收集依赖。
3. `setVisible` 和 `setDisabled` 接受布尔值或返回布尔值的表达式。
4. `setValue` 接受任意 JSON 值；完整 `{{...}}` 字符串会被求值，普通字符串按字面量保存。
5. 没有 `else` 时，条件为假不会修改当前状态。
6. 初始表单创建时会先求值一次；同一字段的多个 reaction 按声明顺序执行，后者覆盖前者。
7. 动作顺序固定为 `setVisible → setDisabled → setValue`。
8. A 依赖 B 会建立 `B → A` 的图边。自循环、双向循环或更长循环会抛出 `DependencyCycleError`，错误中包含类似 `A -> B -> A` 的完整路径。

表达式解析器采用递归下降算法，只允许以下语法：

```text
$deps.path
"字符串" / '字符串'、数字、true、false、null
===、!==、&&、||、!
( ... )
```

不支持属性访问、函数调用、赋值、模板字符串或其他 JavaScript 语法；实现中不会使用 `eval` 或 `new Function`。单条表达式最多 4096 个字符，括号与连续一元运算最多嵌套 64 层；超限会返回 `ExpressionError`，不会把解析器的栈错误泄漏给应用。

`maxTransactionDepth` 限制的是一条因果链的级联深度，不是同一层受影响字段的数量。因此，一个字段同时驱动大量并列字段仍是合法联动，真正的深层级联和运行时重入循环才会被中止。

## React API

### `SchemaForm`

```ts
interface SchemaFormProps<TSubmit = unknown> {
  schema: SchemaNode | string;
  form?: FormApi;
  options?: Omit<FormOptions<TSubmit>, 'schema'>;
  onSubmit?: FormSubmitHandler<TSubmit>;
  className?: string;
  children?: React.ReactNode;
}
```

- 不传 `form` 时，组件内部创建独立 FormApi，并在卸载时 `dispose`。
- 传入 `form` 时，生命周期由调用方管理，适合多区域共享同一个表单。
- `onSubmit` 属性优先于 `options.onSubmit`。
- 不传 `children` 会自动渲染 `SchemaRenderer`；传入 `children` 后请自行渲染它。
- 外层 antd `Form` 使用 `component={false}`，不会额外生成原生 `<form>` 标签。

### `SchemaRenderer`

```tsx
<SchemaRenderer schema={schema} form={form} className="profile-form" />
```

它负责把 Schema 节点转换成 React 树。若没有显式 `form` 且不在 `SchemaForm` 上下文中，会自动创建一个本地表单；需要调用 `validate` 或 `submit` 时，建议显式使用 `useForm` 或 `createForm`。

### `useForm` 与 `useFormContext`

`useForm` 在组件挂载期间创建一个稳定的 FormApi；`useFormContext` 只能在 `SchemaForm` 子树中调用，用于让深层的自定义操作组件共享最近的表单实例：

```tsx
import type { ReactElement } from 'react';
import { Button } from 'antd';
import { SchemaForm, SchemaRenderer, useForm, useFormContext } from '@jasw/pro-cell';
import type { SchemaNode } from '@jasw/pro-cell';

function SubmitButton(): ReactElement {
  const form = useFormContext();
  return <Button onClick={() => void form.submit()}>提交</Button>;
}

export function ProfilePanel({ schema }: { schema: SchemaNode }): ReactElement {
  const form = useForm({ schema, initialValues: { 'user.phone': '' } });
  return (
    <SchemaForm schema={schema} form={form}>
      <SchemaRenderer schema={schema} form={form} />
      <SubmitButton />
    </SchemaForm>
  );
}
```

通常顶层页面使用 `useForm`，而深层按钮、摘要或自定义字段组件使用 `useFormContext`；不要在同一层重复创建两个表单实例。

### `createForm`

`createForm` 不依赖 React 生命周期，适合非 React 逻辑、测试和服务端准备数据：

```ts
const form = createForm({
  schema,
  initialValues: { accountType: 'personal' },
});

const updated = form.setValue('accountType', 'business');
if (!updated.ok) {
  console.error(updated.error.code, updated.error.message);
}

const validation = await form.validate();
if (!validation.valid) {
  console.log(validation.errors);
}

form.dispose();
```

每个实例拥有独立的 vanilla Zustand store，不会把不同表单的字段混在一起。`visible: false` 会卸载该字段的 React 节点但保留值；`disabled: true` 只向组件传递禁用属性，不会自动清除值。全表单校验仍会执行隐藏或禁用字段的静态规则；条件校验请使用 `custom` 校验器读取 `context.values` 后自行短路。

### FormApi 速查

| 方法                            | 返回值                              | 说明                                       |
| ------------------------------- | ----------------------------------- | ------------------------------------------ |
| `getValue(path)`                | `unknown`                           | 读取一个扁平路径值                         |
| `getValues()`                   | `Readonly<Record<string, unknown>>` | 读取当前全部值的快照                       |
| `setValue(path, value)`         | `Result<void, ProCellError>`        | 更新单字段并触发 reaction                  |
| `setValues(values)`             | `Result<void, ProCellError>`        | 批量更新，按传入键触发联动                 |
| `setVisible(path, visible)`     | `Result<void, ProCellError>`        | 手动设置显隐                               |
| `setDisabled(path, disabled)`   | `Result<void, ProCellError>`        | 手动设置禁用                               |
| `getFieldState(path)`           | `FieldState`                        | 读取值、错误、显隐、禁用、校验中和 touched |
| `validateField(path, options?)` | `Promise<ValidationResult>`         | 校验单字段                                 |
| `validate(options?)`            | `Promise<FormValidationResult>`     | 校验全部已声明字段和值字段                 |
| `submit(options?)`              | `Promise<SubmitResult>`             | 先校验，再执行 `onSubmit`                  |
| `reset(values?)`                | `Result<void, ProCellError>`        | 取消异步任务并恢复初始/指定值              |
| `subscribe(listener)`           | `Unsubscribe`                       | 订阅完整快照变化                           |
| `dispose()`                     | `void`                              | 取消任务、断开 tracker 和释放订阅          |

`FieldState` 包含 `value`、`error`、`errors`、`visible`、`disabled`、`validating`、`touched`。渲染器会把第一条错误映射到 `Form.Item.help`，把错误或验证中状态映射到 `validateStatus`。

## 组件注册与值适配

默认全局注册表已经包含 `Input`、`Select`、`Switch`、`Table` 和 `Fragment`。外部组件通过 `registerComponent` 注入：

```tsx
import { registerComponent } from '@jasw/pro-cell';
import type { ReactElement } from 'react';

interface MySelectProps {
  value?: string;
  disabled?: boolean;
  options?: readonly { label: string; value: string }[];
  onValueChange?: (value: string) => void;
}

function MySelect({ value, disabled, options = [], onValueChange }: MySelectProps): ReactElement {
  return (
    <select
      value={value ?? ''}
      disabled={disabled}
      onChange={(event) => onValueChange?.(event.target.value)}
    >
      <option value="">请选择</option>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

const registered = registerComponent('MySelect', MySelect, {
  valueProp: 'value',
  changeProp: 'onValueChange',
});

if (!registered.ok) {
  throw registered.error;
}
```

对应 Schema：

```json
{
  "$comp": "MySelect",
  "name": "department",
  "props": {
    "label": "部门",
    "options": [
      { "label": "研发", "value": "engineering" },
      { "label": "设计", "value": "design" }
    ]
  }
}
```

适配器选项：

- `valueProp`：组件接收当前字段值的属性名，默认 `value`；Switch 等布尔组件通常使用 `checked`。
- `changeProp`：组件接收变更回调的属性名，默认 `onChange`。
- `eventToValue`：把组件回调参数转换为字段值。Input 默认读取 `event.target.value`，Switch 默认读取 `event.target.checked`，Select 默认使用回调值本身。
- `override: true`：显式覆盖同名组件。重复注册但未设置该选项会返回 `RegistryError`。

需要隔离注册表时：

```ts
import { createComponentRegistry, createForm } from '@jasw/pro-cell';

const registry = createComponentRegistry();
const registration = registry.registerComponent('MySelect', MySelect);
if (!registration.ok) throw registration.error;

const form = createForm({ schema, registry });
```

这样组件只对传入该 registry 的表单生效，不会污染全局注册表。

## 校验引擎

### 内置规则

```json
{
  "$comp": "Input",
  "name": "phone",
  "props": { "label": "手机号" },
  "rules": [
    { "type": "required", "message": "请输入手机号" },
    { "type": "maxLength", "value": 11 },
    { "type": "pattern", "value": "^1\\d{10}$", "message": "手机号格式不正确" }
  ]
}
```

- `required`：拒绝 `undefined`、`null`、空字符串和空数组。
- `maxLength`：检查字符串或数组长度；空值由 `required` 决定，其他规则会跳过空值。
- `pattern`：使用 `value` 和可选 `flags` 创建正则表达式。
- 规则按声明顺序运行，首个失败即停止；错误显示在对应 `Form.Item` 下。

### 异步自定义规则

规则保持 JSON 可序列化，只保存 `validatorId`：

```json
{
  "$comp": "Input",
  "name": "phone",
  "props": { "label": "手机号" },
  "rules": [{ "type": "required" }, { "type": "custom", "validatorId": "phoneAvailable" }]
}
```

运行时注入校验器：

```ts
import { err, ok, ValidationError } from '@jasw/pro-cell';
import type { ValidatorRegistry } from '@jasw/pro-cell';

const validators: ValidatorRegistry = {
  phoneAvailable: async (value, { field, values, signal }) => {
    const country = String(values.country ?? 'CN');
    const response = await fetch(
      `/api/phone/check?country=${encodeURIComponent(country)}&field=${encodeURIComponent(field)}&value=${encodeURIComponent(String(value ?? ''))}`,
      { signal },
    );
    if (!response.ok) {
      return err(new ValidationError('手机号校验服务不可用'));
    }
    return ok(undefined);
  },
};

const form = createForm({ schema, validators });
const result = await form.validateField('phone');
```

同一个字段启动新校验时，旧校验会自动 abort；校验器可以读取整份 `context.values`，因此校验期间任意字段值变化也会使旧上下文失效。只有当前运行的控制器可以提交结果，过期结果会被丢弃。外部信号、`submit`、`reset` 和 `dispose` 同样会取消未完成任务。取消结果使用 `cancelled: true` 标记，不会作为普通错误写入 `errors`。

## Result 与错误处理

预期失败统一返回 `Result<T, E>`：

```ts
const result = form.setValue('accountType', 'business');
if (result.ok) {
  console.log('更新成功');
} else {
  console.error(result.error.code, result.error.message);
}
```

根入口导出 `ok`、`err`、`isOk`、`isErr`、`map`、`flatMap` 和 `unwrapOr`，以及以下领域错误：

| 错误                                        | 典型原因                                                |
| ------------------------------------------- | ------------------------------------------------------- |
| `SchemaParseError`                          | JSON 无效、节点结构不合法、带规则/联动的节点缺少 `name` |
| `ComponentNotFoundError`                    | `$comp` 未在当前注册表中注册                            |
| `RegistryError`                             | 重复注册、适配器配置无效                                |
| `ExpressionError`                           | 联动表达式语法不被安全 DSL 支持                         |
| `DependencyCycleError`                      | 依赖图存在环；按约定抛出而不是包在 Result 中            |
| `ReactionExecutionError`                    | 联动动作、setter 或订阅回调失败                         |
| `ValidationError` / `ValidationEngineError` | 规则失败或校验器异常                                    |
| `FormSubmitError`                           | 提交前校验失败或提交回调失败                            |
| `AbortError`                                | 校验或提交被取消                                        |

需要异常风格时可显式使用 `parseOrThrow`；不要把未知异常直接当作普通字符串吞掉，边界层会将其包装为对应领域错误。

## AbortController 取消示例

```ts
const controller = new AbortController();
const pending = form.validate({ signal: controller.signal });

// 用户切换页面、修改了同一字段或点击“取消”时调用。
controller.abort();

const validation = await pending;
if (validation.cancelled) {
  console.log('本次校验已取消，不展示错误');
}
```

提交同样支持 `signal`：

```ts
const result = await form.submit({ signal: controller.signal });
if (!result.ok && result.error.code === 'ABORT_ERROR') {
  // 取消不是服务端失败，也不应显示为字段错误。
}
```

## Table v1

`Table` 组件将常用属性直接传给 antd `Table`，适合展示由 Schema 配置的只读表格：

```json
{
  "$comp": "Table",
  "props": {
    "rowKey": "id",
    "pagination": false,
    "columns": [
      { "title": "地址类型", "dataIndex": "type" },
      { "title": "地址", "dataIndex": "address" }
    ],
    "dataSource": [
      { "id": "billing", "type": "账单", "address": "上海" },
      { "id": "shipping", "type": "收货", "address": "杭州" }
    ]
  }
}
```

当前版本不实现分页状态管理、可编辑单元格、行级字段路径、行校验或表格提交协议。需要编辑表格时，请先在业务层管理 `dataSource`，或注册专用的自定义组件。

## 源码导读

源码按职责拆分，便于从一个包中按需阅读和测试：

```text
packages/
├─ shared/       Result、错误、Schema 类型、路径和校验规则
├─ core/         SchemaParser、ComponentRegistry、安全表达式、DependencyTracker
├─ react/        createForm/useForm、SchemaForm、SchemaRenderer、内置组件
├─ examples/     Vite + React 19 示例应用和三个联动 Schema
└─ pro-cell/     唯一公开包，聚合并打包以上内部模块
```

重点文件：

- `packages/shared/src/result.ts`：函数式 Result 组合工具；
- `packages/shared/src/errors.ts`：稳定错误码和领域错误；
- `packages/shared/src/schema.ts`：`$comp` 协议和结构守卫；
- `packages/shared/src/validation.ts`：内置/异步校验和 Abort 辅助函数；
- `packages/core/src/schema-parser.ts`：WeakMap AST 缓存及递归渲染；
- `packages/core/src/expression.ts`：不依赖 `eval` 的递归下降表达式解析器；
- `packages/core/src/dependency-tracker.ts`：依赖图、拓扑排序和串行 reaction 队列；
- `packages/react/src/formStore.ts`：独立 vanilla Zustand 表单状态和异步生命周期；
- `packages/react/src/renderer.tsx`：React 19 渲染、Form.Item 错误映射和上下文。

核心接口和复杂算法均附有 JSDoc；DependencyTracker 的类注释明确记录拓扑检测复杂度 O(V+E)。

## 仓库示例

```bash
pnpm install
pnpm --filter @jasw/pro-cell-examples dev
```

示例位于 `packages/examples/src/schemas/`：

1. `country-region.json`：国家 → 省份 → 城市的级联可见性和值清理；
2. `account-type.json`：账户类型驱动企业字段可见、禁用和默认值；
3. `billing-shipping.json`：`sameAs` 驱动收货地址，并演示 `setValue` 与只读 Table。

示例的 `src/main.tsx` 已导入 `@ant-design/v5-patch-for-react-19`，可以作为应用入口模板。

## 本地开发与质量门禁

```bash
pnpm install
pnpm check
```

`pnpm check` 会依次执行格式检查、lint、类型检查、覆盖率测试和构建。也可以单独运行 `pnpm test` 或任一 Turbo 任务。

Turbo 会在 workspace 间按依赖顺序运行 `build`、`typecheck`、`lint`、`test` 和 `test:coverage`。`shared`、`core` 与 `react` 的 lines、functions、branches、statements 覆盖率门槛均为 92% 以上；React 包同时有渲染集成测试。

格式化检查：

```bash
pnpm format:check
pnpm format
```

提交前 Husky 的 `pre-commit` 钩子运行 `lint-staged`，`commit-msg` 钩子使用 commitlint 检查 Conventional Commits。GitHub CI 会执行完整质量门禁。提交信息示例：

```text
feat(core): 支持安全联动表达式
fix(react): 修复异步校验过期结果
docs: 补充 React 19 使用示例
```

## 构建与发布

源码仓库使用 pnpm 11，开发和 CI 需要 Node.js 22.13 或更高版本；发布后的 `@jasw/pro-cell` 运行时仍支持 Node.js 20+。仓库提供 `.nvmrc` 方便切换版本。

根目录 `packages/pro-cell` 使用 Vite library mode 构建四个入口，每个入口同时产出 ESM、CJS 和 TypeScript 声明：

```text
dist/index.js      dist/index.cjs      dist/index.d.ts
dist/core.js       dist/core.cjs       dist/core.d.ts
dist/react.js      dist/react.cjs      dist/react.d.ts
dist/shared.js     dist/shared.cjs     dist/shared.d.ts
```

发布前建议执行完整门禁并检查 tarball 内容：

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm pack:check
```

确认 npm 登录账号是 `jasw` 后发布唯一公开包：

```bash
pnpm whoami
pnpm --filter @jasw/pro-cell publish --access public
```

包的 `publishConfig.access` 已设为 `public`，版本由 `packages/pro-cell/package.json` 统一管理。`publish` 会通过 `prepublishOnly` 再跑一次完整门禁，`prepack` 会重建公开包及其内部依赖。内部 workspace 包保持 `private: true`，不会被单独发布，也不会作为发布产物中的运行时依赖。

GitHub CI 还会把实际 tarball 安装到 workspace 外的临时项目，分别验证根入口及 `/core`、`/react`、`/shared` 的 ESM、CommonJS 和 TypeScript 用法，并检查产物中没有残留私有 workspace 引用。

## 许可与变更记录

项目使用 MIT License。版本记录见 [CHANGELOG.md](./CHANGELOG.md)，协作与提交规范见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

- [GitHub 仓库](https://github.com/jasw555/pro-cell)
- [问题反馈](https://github.com/jasw555/pro-cell/issues)
- [npm 包](https://www.npmjs.com/package/@jasw/pro-cell)
