/**
 * `@jasw/pro-cell/react` 子路径。
 * 导出 React 19 渲染器、FormApi 和 React 注册表；它仍与根入口共享版本和发布周期。
 */
export {
  createForm,
  FormContext,
  SchemaForm,
  SchemaRenderer,
  useForm,
  useFormContext,
  registerComponent,
  ReactComponentRegistry,
  createComponentRegistry,
  defaultRegistry,
  getRegisteredComponent,
  FragmentComponent,
  InputComponent,
  SelectComponent,
  SwitchComponent,
  TableComponent,
  registerBuiltinComponents,
} from '@jasw/pro-cell-react';
// 为 React 子路径提供简洁别名；仍然只有一个公开 npm 包。
export { ReactComponentRegistry as ComponentRegistry } from '@jasw/pro-cell-react';
export type {
  AsyncOptions,
  ComponentAdapterOptions,
  ComponentRegistryLike,
  FieldState,
  FormApi,
  FormListener,
  FormOptions,
  FormStateSnapshot,
  FormSubmitContext,
  FormSubmitHandler,
  FormValidationResult,
  RegisteredComponent,
  SchemaFormProps,
  SchemaRendererProps,
  SubmitResult,
  Unsubscribe,
  ValidationResult,
  ReactionActions,
  ReactionConfig,
  SchemaNode,
  ValidationRuleConfig,
  Validator,
} from '@jasw/pro-cell-react';
