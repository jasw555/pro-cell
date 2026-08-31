/**
 * React 19 下运行 antd v5 测试前加载官方兼容补丁。
 *
 * 补丁只修改测试进程中的 antd 兼容行为，不会改变 Pro Cell 运行时导出；
 * 应用消费者仍应在自己的入口文件显式导入同一补丁。
 */
import '@ant-design/v5-patch-for-react-19';
