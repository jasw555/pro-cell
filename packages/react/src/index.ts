/** React 19 适配层：FormApi、SchemaRenderer 和 antd 内置组件。 */
export { createForm } from './formStore';
import { defaultRegistry } from './registry';
import { registerBuiltinComponents } from './builtins';

// 默认注册表同时服务于根入口 SchemaParser；模块初始化时注册一次内置组件。
registerBuiltinComponents(defaultRegistry);

export {
  FormContext,
  SchemaForm,
  SchemaRenderer,
  useForm,
  useFormContext,
  registerComponent,
} from './renderer';
export {
  ReactComponentRegistry,
  createComponentRegistry,
  defaultRegistry,
  getRegisteredComponent,
} from './registry';
export {
  FragmentComponent,
  InputComponent,
  SelectComponent,
  SwitchComponent,
  TableComponent,
  registerBuiltinComponents,
} from './builtins';
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
} from './types';
export type {
  ReactionActions,
  ReactionConfig,
  SchemaNode,
  ValidationRuleConfig,
  Validator,
} from './types';
