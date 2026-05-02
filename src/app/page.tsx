import { Button, Card, Typography, Space } from 'antd';
import Link from 'next/link';

const { Title, Paragraph } = Typography;

export default function HomePage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
      <Card className="w-full max-w-lg text-center shadow-lg">
        <Space direction="vertical" size="large" className="w-full">
          <Title level={1} className="!mb-0">
            WoBase
          </Title>
          <Paragraph className="text-gray-500">
            基于 Next.js + Supabase 的多应用管理系统
          </Paragraph>

          <div className="grid grid-cols-2 gap-4 text-left">
            <Card size="small">
              <Typography.Text strong>多应用架构</Typography.Text>
              <br />
              <Typography.Text type="secondary">支持多个 App 统一管理</Typography.Text>
            </Card>
            <Card size="small">
              <Typography.Text strong>用户管理</Typography.Text>
              <br />
              <Typography.Text type="secondary">基础/付费/团队会员体系</Typography.Text>
            </Card>
            <Card size="small">
              <Typography.Text strong>财务管理</Typography.Text>
              <br />
              <Typography.Text type="secondary">钱包、交易流水、VIP 管理</Typography.Text>
            </Card>
            <Card size="small">
              <Typography.Text strong>权限控制</Typography.Text>
              <br />
              <Typography.Text type="secondary">RBAC + RLS 安全策略</Typography.Text>
            </Card>
          </div>

          <Space>
            <Link href="/login">
              <Button type="primary" size="large">
                登录
              </Button>
            </Link>
            <Link href="/register">
              <Button size="large">注册</Button>
            </Link>
          </Space>

          <Paragraph type="secondary" className="text-sm">
            部署于 Vercel + Supabase
          </Paragraph>
        </Space>
      </Card>
    </div>
  );
}