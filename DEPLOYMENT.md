# Vercel + Supabase 部署指南

本文档详细介绍如何将多应用管理系统部署到 Vercel 和 Supabase。

## 目录

1. [架构概览](#架构概览)
2. [前置要求](#前置要求)
3. [Supabase 配置](#supabase-配置)
4. [Vercel 配置](#vercel-配置)
5. [本地开发](#本地开发)
6. [CI/CD 配置](#cicd-配置)
7. [生产环境检查清单](#生产环境检查清单)

---

## 架构概览

```
┌─────────────────────────────────────────────────────────────┐
│                        Vercel                               │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  Next.js 14 App                                     │    │
│  │  ┌─────────────┐  ┌─────────────┐  ┌────────────┐   │    │
│  │  │  App Router │  │  API Routes │  │  Server    │   │    │
│  │  │  (SSR/SSG)  │  │  (Server)   │  │  Actions   │   │    │
│  │  └─────────────┘  └─────────────┘  └────────────┘   │    │
│  └─────────────────────────────────────────────────────┘    │
└────────────────────────┬────────────────────────────────────┘
                         │
                         │ HTTP / WebSocket
                         │
┌────────────────────────▼────────────────────────────────────┐
│                      Supabase                               │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐   │
│  │  Postgres    │  │  Auth        │  │  Realtime        │   │
│  │  (Database)  │  │  (JWT/RLS)   │  │  (WebSocket)     │   │
│  └──────────────┘  └──────────────┘  └──────────────────┘   │
│  ┌──────────────┐  ┌──────────────┐                         │
│  │  Storage     │  │  Edge Funcs  │                         │
│  │  (Files)     │  │  (Deno)      │                         │
│  └──────────────┘  └──────────────┘                         │
└─────────────────────────────────────────────────────────────┘
```

---

## 前置要求

- Node.js 18+ (推荐 20 LTS)
- pnpm 8+ (推荐 9)
- Git
- [Vercel CLI](https://vercel.com/docs/cli) (可选)
- [Supabase CLI](https://supabase.com/docs/guides/cli)

### 安装 CLI 工具

```bash
# 安装 Supabase CLI
npm install -g supabase

# 安装 Vercel CLI (可选)
npm install -g vercel
```

---

## Supabase 配置

### 1. 创建 Supabase 项目

1. 访问 [Supabase Dashboard](https://app.supabase.com/)
2. 点击 "New Project"
3. 选择组织、输入项目名称
4. 选择区域（推荐离你用户最近的区域）
5. 等待项目创建完成

### 2. 获取 API 密钥

在项目 Settings → API 页面获取：

- **URL**: `https://<project-ref>.supabase.co`
- **Anon Key**: 客户端使用的公钥（权限受限）
- **Service Role Key**: 服务端使用的私钥（可绕过 RLS）

⚠️ **重要**: Service Role Key 绝对不能暴露给客户端！

### 3. 运行数据库迁移

```bash
# 登录 Supabase
supabase login

# 关联本地项目到远程
supabase link --project-ref <your-project-ref>

# 推送迁移到远程数据库
supabase db push
```

### 4. 配置身份验证 (Auth)

在 Dashboard → Authentication → Settings 配置：

- **Site URL**: 你的应用 URL（如 `https://your-app.vercel.app`）
- **Redirect URLs**: 允许的回调地址
  - `https://your-app.vercel.app/auth/callback`
  - `http://localhost:3000/auth/callback` (开发环境)

#### 启用第三方登录 (可选)

在 Providers 页面启用：
- Email (默认开启)
- Google
- WeChat
- Apple
- 其他...

### 5. 配置环境变量到 Supabase

对于 Edge Functions 使用的环境变量：

```bash
# 设置 Edge Function 环境变量
supabase secrets set SUPABASE_URL=https://<project-ref>.supabase.co
supabase secrets set SUPABASE_SERVICE_ROLE_KEY=<your-service-role-key>
supabase secrets set CRON_SECRET=<random-secret-for-cron>
```

### 6. 部署 Edge Functions

```bash
# 部署所有 Edge Functions
supabase functions deploy

# 或单独部署
supabase functions deploy join-app
supabase functions deploy recompute-tier
supabase functions deploy payment-callback
supabase functions deploy tier-downgrade-cron
```

---

## Vercel 配置

### 1. 导入项目

1. 访问 [Vercel Dashboard](https://vercel.com/dashboard)
2. 点击 "Add New Project"
3. 导入 GitHub/GitLab/Bitbucket 仓库
4. 选择本仓库

### 2. 配置构建设置

| 设置项 | 值 |
|--------|-----|
| Framework Preset | Next.js |
| Build Command | `pnpm build` |
| Output Directory | `.next` |
| Install Command | `pnpm install` |

### 3. 配置环境变量

在 Project Settings → Environment Variables 添加：

#### 必需变量

```
NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<your-anon-key>
SUPABASE_SERVICE_ROLE_KEY=<your-service-role-key>
NEXT_PUBLIC_APP_ENV=prod
```

#### 可选变量

```
# 支付
WECHAT_PAY_MCH_ID=
WECHAT_PAY_API_KEY=
WORLDFIRST_API_KEY=

# 第三方登录
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
WECHAT_APP_ID=
WECHAT_APP_SECRET=

# 监控
NEXT_PUBLIC_SENTRY_DSN=

# 功能开关
NEXT_PUBLIC_ENABLE_REALTIME=true
ENABLE_PAYMENT=true
```

### 4. 配置自定义域名 (可选)

1. 在 Project Settings → Domains 添加域名
2. 按提示配置 DNS 记录
3. 等待 SSL 证书签发

---

## 本地开发

### 1. 克隆仓库

```bash
git clone <your-repo-url>
cd wobase-server
```

### 2. 安装依赖

```bash
pnpm install
```

### 3. 启动 Supabase 本地开发环境

```bash
# 启动 Supabase 本地服务
supabase start

# 查看状态和服务 URL
supabase status
```

### 4. 配置本地环境变量

```bash
cp .env.local.example .env.local
# 编辑 .env.local 填入本地开发配置
```

### 5. 启动 Next.js 开发服务器

```bash
pnpm dev
```

访问 http://localhost:3000

### 6. 本地 Edge Functions 开发

```bash
# 本地运行 Edge Function
supabase functions serve join-app --env-file supabase/functions/.env

# 测试本地 Edge Function
curl -X POST http://localhost:54321/functions/v1/join-app \
  -H "Authorization: Bearer <user-jwt>" \
  -H "Content-Type: application/json" \
  -d '{"app_id": "<app-uuid>", "env": "dev"}'
```

---

## CI/CD 配置

### GitHub Actions 工作流

本项目包含三个工作流：

#### 1. CI (`.github/workflows/ci.yml`)

**触发条件**: PR 或 push 到 main/develop

**任务**:
- ESLint 检查
- TypeScript 类型检查
- 单元测试
- RLS 策略测试

#### 2. Deploy Staging (`.github/workflows/deploy-staging.yml`)

**触发条件**: push 到 develop 分支

**任务**:
- 构建并部署到 Vercel Preview
- 运行数据库迁移

#### 3. Deploy Production (`.github/workflows/deploy-production.yml`)

**触发条件**: push 到 main 分支 或 tag

**任务**:
- 预部署检查（测试、lint、类型检查）
- 数据库迁移
- 构建并部署到 Vercel Production

### 配置 GitHub Secrets

在仓库 Settings → Secrets and variables → Actions 添加：

```
# Vercel
VERCEL_TOKEN=<your-vercel-token>
VERCEL_ORG_ID=<your-vercel-org-id>
VERCEL_PROJECT_ID=<your-vercel-project-id>

# Supabase
SUPABASE_ACCESS_TOKEN=<your-supabase-access-token>
SUPABASE_PROJECT_ID=<your-project-ref>

# 可选：通知
SLACK_WEBHOOK_URL=<your-slack-webhook>
```

### 获取 Vercel Token

```bash
vercel login
vercel tokens create
```

### 获取 Supabase Access Token

在 [Supabase Dashboard](https://app.supabase.com/account/tokens) 创建 Personal Access Token。

---

## 生产环境检查清单

### 部署前

- [ ] 所有数据库迁移已测试
- [ ] RLS 策略已通过测试
- [ ] Edge Functions 已部署
- [ ] 环境变量已配置
- [ ] 第三方登录回调 URL 已配置
- [ ] SSL 证书已配置

### 部署后

- [ ] 健康检查端点返回 200
- [ ] 用户注册/登录流程正常
- [ ] 支付流程测试通过
- [ ] 定时任务正常运行
- [ ] 监控告警已配置

### 监控和日志

1. **Vercel Analytics**: 访问速度、Core Web Vitals
2. **Supabase Logs**: 数据库查询、API 调用
3. **错误追踪**: 配置 Sentry 或其他错误追踪服务

### 备份策略

1. **数据库**: Supabase 自动每日备份，可手动创建时间点恢复
2. **环境变量**: 使用 Vercel 的环境变量管理，避免本地存储
3. **代码**: Git 版本控制

---

## 故障排查

### 数据库迁移失败

```bash
# 查看迁移状态
supabase migration list

# 重置本地数据库
supabase db reset

# 手动修复冲突后重新推送
supabase db push
```

### Edge Function 部署失败

```bash
# 查看函数日志
supabase functions logs <function-name>

# 本地调试
supabase functions serve <function-name>
```

### Vercel 构建失败

检查构建日志，常见问题：
- Node 版本不匹配 → 在 `package.json` 指定 `engines`
- 环境变量缺失 → 在 Vercel Dashboard 配置
- TypeScript 错误 → 本地运行 `pnpm type-check` 修复

---

## 参考资料

- [Next.js 部署文档](https://nextjs.org/docs/deployment)
- [Supabase 文档](https://supabase.com/docs)
- [Vercel 文档](https://vercel.com/docs)
- [Supabase CLI 文档](https://supabase.com/docs/guides/cli)
