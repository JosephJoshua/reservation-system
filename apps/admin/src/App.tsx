import { ConfigProvider, Layout } from 'tdesign-react'
import zhCN from 'tdesign-react/es/locale/zh_CN'
import { ServiceStatus } from './ServiceStatus'

export function App() {
  return (
    <ConfigProvider globalConfig={zhCN}>
      <Layout style={{ minHeight: '100vh' }}>
        <Layout.Header className="admin-header">球馆管理</Layout.Header>
        <Layout.Content style={{ padding: 24 }}>
          <ServiceStatus />
        </Layout.Content>
      </Layout>
    </ConfigProvider>
  )
}
