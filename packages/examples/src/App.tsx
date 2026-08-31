import { useMemo, useState } from 'react';
import { Card, Select, Space, Typography } from 'antd';
import { SchemaForm, isSchemaNode } from '@jasw/pro-cell';
import type { SchemaNode } from '@jasw/pro-cell';
import accountSchema from './schemas/account-type.json';
import billingSchema from './schemas/billing-shipping.json';
import countrySchema from './schemas/country-region.json';

/**
 * JSON 模块会把 `$comp` 等字面量拓宽为 string，因此在示例入口先做一次运行时校验。
 * 这样 JSON 被手工改坏时会在启动阶段给出明确错误，而不是依赖类型断言掩盖问题。
 */
function asSchemaNode(value: unknown): SchemaNode {
  if (!isSchemaNode(value)) {
    throw new Error('示例 Schema 不是合法的 $comp 节点');
  }
  return value;
}

const scenarios = {
  country: { label: '国家/地区联动', schema: asSchemaNode(countrySchema) },
  account: { label: '账户类型联动', schema: asSchemaNode(accountSchema) },
  billing: { label: '账单/收货地址联动', schema: asSchemaNode(billingSchema) },
} as const;

type ScenarioKey = keyof typeof scenarios;

const scenarioOptions: Array<{ value: ScenarioKey; label: string }> = [
  { value: 'country', label: scenarios.country.label },
  { value: 'account', label: scenarios.account.label },
  { value: 'billing', label: scenarios.billing.label },
];

export function App(): React.ReactElement {
  const [scenario, setScenario] = useState<ScenarioKey>('country');
  const current = useMemo(() => scenarios[scenario], [scenario]);

  return (
    <main style={{ maxWidth: 960, margin: '40px auto', padding: '0 20px' }}>
      <Space direction="vertical" size="large" style={{ width: '100%' }}>
        <Typography.Title level={2}>Pro Cell 联动引擎示例</Typography.Title>
        <Select<ScenarioKey>
          value={scenario}
          options={scenarioOptions}
          onChange={setScenario}
          style={{ width: 280 }}
        />
        <Card title={current.label} key={scenario}>
          <SchemaForm schema={current.schema} />
        </Card>
      </Space>
    </main>
  );
}
