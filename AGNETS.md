# 使用 Supabase 作为后端的多应用管理系统方案

## 目标

基于 Supabase 搭建统一后端，支持多个 APP/桌面应用，测试环境、生产环境分别接入，并提供以下核心能力：

- 用户管理
- **用户级别**（基础 / 付费 / 团队会员）与数据访问范围
- 财务管理
- VIP 管理
- 用户权限管理（RBAC + 可扩展策略；RLS 为核心 enforcement）

## 技术栈（后端）

- Supabase Auth：用户认证（邮箱、手机号、OAuth 可选）
- Supabase Postgres：核心业务数据
- Supabase Storage：头像、票据、附件等文件
- Supabase Realtime：订单状态、账户余额变更实时推送（可选）
- Supabase Edge Functions：支付回调、账务结算、异步任务入口
- RLS（Row Level Security）：多租户与权限隔离的核心机制

## 多应用（Multi-App）架构

### 1) 应用主表

`apps`

- `id` (uuid, pk)
- `app_key` (text, unique)
- `name` (text)
- `platform` (text) - ios/android/web/desktop
- `status` (text) - active/disabled
- `created_at` (timestamptz)

### 2) 应用用户绑定

`app_users`

- `id` (uuid, pk)
- `app_id` (uuid, fk -> apps.id)
- `user_id` (uuid, fk -> auth.users.id)
- `env` (text) — dev/test/prod，与 RLS 会话环境一致
- `user_tier` (text 或 enum) — `basic`（基础）| `paid`（付费）| `team`（团队会员），见下文「用户级别」
- `tier_expires_at` (timestamptz, nullable) — 付费/团队等档位的到期时刻；到期后应在库内降级（见「关键安全原则」），RLS 须结合该字段判断**有效档位**，避免永久授权
- `app_user_status` (text) - active/banned
- `created_at` (timestamptz)
- unique(`app_id`, `user_id`, `env`)

> 说明：同一个 Supabase Auth 用户可同时属于多个应用，实现统一账号跨应用。`user_tier` 表示在该应用、该环境下的**产品档位**，与后台 RBAC（运营角色）正交：前者管「用户能用什么功能/数据」，后者管「谁能管理租户」。

## 环境与数据隔离（dev / test / prod）

业务数据除按 **应用（`app_id`）** 隔离外，还需按 **运行环境** 隔离，避免测试或开发数据与生产混读混写。

### 环境枚举

使用 Postgres 枚举或 `text` + 校验约束，取值固定为：`dev`、`test`、`prod`。

### 表设计约定

凡面向客户端或面向运营后台、且需区分环境的数据表，增加列：

- `env` (text 或 app_environment enum) — `dev` | `test` | `prod`

**需要带 `env` 的典型表**：`app_users`、`wallet_accounts`、`wallet_transactions`、`vip_plans`、`user_vips`、`user_status_logs`、`user_roles`，以及所有按「应用租户」划分的业务表。

**唯一约束需包含环境**，例如：

- `app_users`：`unique(app_id, user_id, env)` — 同一账号在同一应用下，开发/测试/生产各有一套成员关系与状态
- `wallet_accounts`：`unique(app_id, user_id, currency, env)`
- `roles`：`unique(app_id, code, env)`（若角色按环境配置）
- `vip_plans`：套餐通常按 `app_id + env` 区分，避免把测试价格误用于生产

**可选：`apps` 表本身**

- 若三个环境共用同一 Supabase 项目（单库多环境数据）：不在 `apps` 上重复 `env`，由各行数据的 `env` 表达环境。
- 若 **每个环境一个 Supabase 项目**：库内可省略 `env` 列（环境即项目边界）；仍可在文档中保留本节，便于单库方案落地。

### 请求上下文：JWT 中携带当前环境（供 RLS 使用）

RLS 需要知道「当前会话要访问哪一套环境的数据」。推荐：

1. 在 **服务端或 Edge Function** 签发/刷新会话时，将当前环境写入 **`auth.users` 的 `app_metadata`（或等价不可由终端用户随意篡改的声明）**，例如 `app_metadata.env = 'prod'`。
2. **不要**用 `user_metadata` 做授权依据（用户可自行修改，不适合作为 RLS 条件）。

在策略中读取示例（思路）：

- `current_setting('request.jwt.claims', true)::json->'app_metadata'->>'env'`
- 或使用 Supabase 文档推荐的 `auth.jwt()` 解析方式（以当前项目 Supabase/Postgres 版本文档为准）

客户端连接 **开发/测试/生产** 时应使用对应环境的 **Anon Key + URL**；若多环境共库，还需保证 JWT 中 `env` 与建连意图一致。

### RLS 隔离规则（应用 + 环境）

在原有「应用 + 用户」条件上，**所有相关策略增加环境匹配**：

- 行级条件：`table.env = <从 JWT 解析出的 env>`
- 若某角色允许跨行读应用内数据，仍必须：`table.app_id` 在授权范围内 **且** `table.env` 与会话环境一致

示例（思路，伪代码）：

```sql
-- USING 中同时约束 app 与环境
table.app_id = ... 
AND table.env = (auth.jwt()->'app_metadata'->>'env')
AND ... -- 用户本人或 RBAC
```

**注意**：若 JWT 中缺少 `env`，应拒绝访问（避免默认落到错误环境）。可在策略中要求 `env` 非空且属于白名单 `dev|test|prod`。

### Service Role 与迁移

- **后台任务 / 管理脚本** 使用 `service_role` 时通常会绕过 RLS，须在应用层明确指定 `env`，避免误删误改其他环境数据。
- 数据迁移、批量修复脚本同样要带 `app_id` + `env` 条件。

## 用户管理模块

### 核心表

`user_profiles`

- `user_id` (uuid, pk, fk -> auth.users.id)
- `display_name` (text)
- `avatar_url` (text)
- `phone` (text)
- `country_code` (text)
- `created_at` (timestamptz)
- `updated_at` (timestamptz)

`user_status_logs`

- `id` (uuid, pk)
- `user_id` (uuid)
- `app_id` (uuid)
- `env` (text) — dev/test/prod
- `action` (text) - create/ban/unban/delete
- `operator_user_id` (uuid)
- `remark` (text)
- `created_at` (timestamptz)

### 功能点

- 用户查询（按 app、状态、时间、关键词）
- 用户封禁/解禁
- 用户资料维护
- 用户操作审计日志

## 财务管理模块

### 核心表

`wallet_accounts`

- `id` (uuid, pk)
- `app_id` (uuid, fk -> apps.id)
- `user_id` (uuid, fk -> auth.users.id)
- `env` (text) — dev/test/prod
- `currency` (text) - CNY/USD/points
- `available_balance` (numeric(18,2))
- `frozen_balance` (numeric(18,2))
- `updated_at` (timestamptz)
- unique(`app_id`, `user_id`, `currency`, `env`)

`wallet_transactions`

- `id` (uuid, pk)
- `app_id` (uuid)
- `env` (text)
- `user_id` (uuid)
- `account_id` (uuid, fk -> wallet_accounts.id)
- `biz_type` (text) - recharge/consume/refund/settle/withdraw
- `amount` (numeric(18,2))
- `direction` (text) - in/out
- `status` (text) - pending/success/failed
- `biz_no` (text)
- `ext` (jsonb)
- `created_at` (timestamptz)

### 建议

- 账务只追加流水，不直接改历史记录
- 余额变更通过数据库函数或事务统一处理
- 对账任务建议通过 Edge Functions + Cron 触发

## VIP 管理模块

### 核心表

`vip_plans`

- `id` (uuid, pk)
- `app_id` (uuid, fk -> apps.id)
- `env` (text) — dev/test/prod
- `name` (text)
- `level` (int)
- `price` (numeric(18,2))
- `duration_days` (int)
- `benefits` (jsonb)
- `status` (text) - active/inactive

`user_vips`

- `id` (uuid, pk)
- `app_id` (uuid, fk -> apps.id)
- `env` (text)
- `user_id` (uuid, fk -> auth.users.id)
- `plan_id` (uuid, fk -> vip_plans.id)
- `start_at` (timestamptz)
- `end_at` (timestamptz)
- `status` (text) - active/expired/cancelled
- `source` (text) - purchase/admin_grant/activity

### 功能点

- VIP 开通、续费、过期
- 按应用隔离 VIP 体系
- 权益配置可通过 `benefits` 动态扩展

## 用户级别（基础 / 付费 / 团队会员）

面向终端用户的产品档位，用于区分默认能力、配额与部分资源的可见/可写范围；与 **VIP 套餐**（`vip_plans` / `user_vips`）可关联：`user_tier` 可由当前有效 VIP、订阅状态或运营策略计算得出。

### 档位语义（建议）

| 档位 | 代码 | 典型能力 |
|------|------|----------|
| 基础 | `basic` | 默认免费能力；资源/功能受限 |
| 付费 | `paid` | 个人付费后的增强能力（存储、导出、高级功能等） |
| 团队会员 | `team` | 组织/协作维度：共享空间、成员席位、团队级资源与审计 |

### 存储位置

- **权威数据源（推荐）**：`app_users.user_tier`（已含 `app_id` + `env`），支付确认、套餐变更、团队绑定等事务内更新；RLS 策略通过 **JOIN `app_users` 或 `exists` 子查询** 读取当前用户的档位，避免仅凭 JWT 盲信。
- **JWT 自定义声明（加速路径）**：将档位镜像到 **`app_metadata`**（例如 `app_metadata.tier` 或与 `app_id`/`env` 组合的嵌套结构），便于策略中快速判断。**不得**使用 `user_metadata` 作为授权依据（用户可自改）。  
  注意：JWT 可能滞后于数据库（例如刚付款未刷新 token），敏感操作仍应以 **库表为准** 或在业务层强制刷新会话。
- **复杂场景**：团队席位、多子账号时，可增设 **团队表 + 成员表**（见下文级联删除），RLS 用 `exists` 关联团队与资源上的 `team_id`。
- **到期降级**：`tier_expires_at` 到期后，`user_tier` 应收敛为 `basic`（或由定时任务/触发器/Edge Function 批量修正）；**授权判定**优先在 RLS/函数中使用「当前时间相对 `tier_expires_at`」的有效档位表达式，避免仅读 `user_tier` 字段而忽略过期。

### 与 RLS 的配合方式（核心）

权限控制的 **强制执行点** 在 Postgres RLS；可选两种建模组合（可同时使用）：

1. **独立权限表 / 档位字段（权威）**  
   - 策略中：`exists (... app_users ... user_tier in ('paid','team'))`  
   - 或资源表带 `required_tier`，策略：`app_users.user_tier` 满足 `>= 所需档位`（需定义档位序或映射表）。

2. **自定义 Claims（Mirror）**  
   - 策略中：`coalesce((auth.jwt()->'app_metadata'->>'tier'), '')` 与库表一致时使用；或 **仅以 claims 做第一层过滤，最终以 `app_users` 校验防篡改**。  
   - 支付/升降级后：更新 `app_users.user_tier`，并通过 Admin API 更新 `app_metadata`，促使用户下次 JWT 携带新档位。

管理员（RBAC）绕开终端档位限制时，仍须满足 `user_roles` + `app_id` + `env`，避免与普通用户策略混淆。

### 团队数据模型与级联（删除团队时清理成员）

- `teams`：`id`, `app_id`, `env`, …
- `team_memberships`：`team_id` → `teams(id)` **`ON DELETE CASCADE`**，`user_id`, `role_in_team`, …

删除团队行时，数据库自动删除所有成员关联，避免悬空成员仍通过旧 `team_id` 访问资源；RLS 仍应绑定「成员存在且团队未删除」。

### 档位变更审计（纠纷与合规）

`user_tier_change_logs`（或等价命名）

- `id`, `app_id`, `env`, `user_id`
- `from_tier`, `to_tier`
- `from_expires_at`, `to_expires_at`（可选，便于核对订阅周期）
- `reason` (text) — purchase_expire/admin_adjust/refund/team_dissolve 等
- `operator_user_id` (uuid, nullable) — 系统自动可为 null
- `created_at` (timestamptz)

任何批量修正 `user_tier` / `tier_expires_at` 的路径（触发器、函数、后台任务）应 **append 审计行**，便于争议处理与对账。

## 关键安全原则

1. **永远不要信任前端传来的 tier**  
   客户端传的档位、到期时间、团队角色等 **一律不参与授权结论**。所有「能否读/写该行」的判断必须在 **PostgreSQL RLS** 与 **SECURITY INVOKER 下的受控函数**（必要时 `SECURITY DEFINER` 置于私有 schema，且入参校验严格）中完成；前端仅做 UI 展示与体验优化。

2. **`tier_expires_at` 与「有效档位」**  
   - 付费到期后必须 **自动降级**（更新 `user_tier` 与/或在 RLS 中将「过期付费」视为 `basic`），禁止依赖 JWT 长期携带 `paid` 造成事实上的永久授权。  
   - RLS 示例思路：`effective_paid` ⇔ `user_tier in ('paid','team') and (tier_expires_at is null or tier_expires_at > now())`，具体以业务规则为准（例如 `team` 是否单独再有到期字段）。

3. **团队权限级联**  
   删除团队时通过 **`ON DELETE CASCADE`**（及相关资源表上对 `team_id` 的外键策略）清理成员与团队附属数据，防止孤儿关联导致越权残留。

4. **审计日志**  
   所有 **tier / 到期时间** 变更写入 **`user_tier_change_logs`**（或等价表），保留旧值、新值、原因与时间，用于纠纷处理与内部追责；敏感批量任务同样记录。

## 权限管理（RBAC）

### RLS + Claims + 权限表：分工（终端用户 vs 运营）

| 维度 | 终端用户（产品档位） | 运营 / 后台（RBAC） |
|------|----------------------|---------------------|
| 目的 | 基础/付费/团队能访问的功能与数据 | 谁能管理用户、财务、VIP、配置 |
| 权威数据 | `app_users.user_tier` + 业务表 | `user_roles`、`roles`、`permissions` |
| JWT | 可选：`app_metadata` 镜像档位、环境 | 可选：`app_metadata` 中的管理员标记 **仅作提示**，RLS 仍以表为准 |
| RLS | `tier` + `app_id` + `env` + 资源条件 | `exists(user_roles...)` + 同上租户隔离 |

**原则**：RLS 表达式尽量 **引用数据库中的成员与权限事实**；JWT claims 用于减少 join 或分层策略时，须与表数据一致性或明确「表优先」。

### 核心表

`roles`

- `id` (uuid, pk)
- `app_id` (uuid, fk -> apps.id)
- `env` (text) — dev/test/prod（若角色按环境区分）
- `code` (text) - super_admin/finance/vip_operator/support
- `name` (text)
- unique(`app_id`, `code`, `env`)

`permissions`

- `id` (uuid, pk)
- `code` (text, unique) - user.read, user.ban, finance.read, vip.write
- `name` (text)

`role_permissions`

- `role_id` (uuid, fk -> roles.id)
- `permission_id` (uuid, fk -> permissions.id)
- unique(`role_id`, `permission_id`)

`user_roles`

- `app_id` (uuid, fk -> apps.id)
- `env` (text)
- `user_id` (uuid, fk -> auth.users.id)
- `role_id` (uuid, fk -> roles.id)
- unique(`app_id`, `user_id`, `role_id`, `env`)

### 权限校验策略

- 前端：按权限码与 **用户级别** 控制菜单/按钮显示（展示层不能替代 RLS）
- 后端：Edge Functions 或 SQL 函数内强制校验权限与档位
- 数据层：**RLS 为核心** — 按 `app_id` + **`env`** + **用户级别（`app_users.user_tier`）** + **RBAC（管理员）** + 资源归属联合判定

### 灵活策略示例（思路）

- **按档位可读**：仅「有效」`paid`/`team` 可读 —— `exists (... app_users au ... and <有效档位条件含 tier_expires_at>)`，勿省略过期判断
- **团队资源**：行带 `team_id`，策略要求 `exists (team_memberships where user_id = auth.uid() and team_id = row.team_id)` 且档位为 `team`
- **Claims 辅助**：`auth.jwt()->'app_metadata'->>'tier' = 'paid'` **且** `exists (app_users ... user_tier = 'paid')`，双因子防止 JWT 与库不一致时的越权

## RLS 安全设计（关键）

所有暴露给客户端访问的业务表默认开启 RLS，并至少遵循：

1. **会话环境匹配**：行数据的 `env` 必须与 JWT（推荐 `app_metadata.env`）一致；缺失或非法 `env` 一律拒绝
2. 用户只能访问自己所属应用与环境下的成员关系（`app_users`：`app_id` + `env`）
3. **用户级别**：受档位控制的资源，必须以库内 **`app_users` 的有效档位**（含 **`tier_expires_at` 与当前时间比较**）及必要的团队/订阅表为满足条件；**不信任前端 tier**；自定义 claims 仅作辅助，且 **不以 `user_metadata` 为授权依据**
4. 普通用户只能访问自己的用户、钱包、VIP 数据（且 `env` 一致）；团队场景扩展为「本人或本团队成员」
5. 管理员角色可按权限访问 **同一应用、同一环境** 内的数据（`user_roles`）
6. 财务相关写操作必须通过受控函数执行

示例（思路）：

- `using (exists (select 1 from app_users au where au.app_id = <table>.app_id and au.env = <table>.env and au.user_id = auth.uid()))`
- 并与 `auth.jwt()` 中解析出的 `env` 做交叉校验，避免仅依赖表内列被篡改的假设（插入/更新策略需约束 `env` 不可改为与 JWT 不一致的值）
- 需要档位时：在上述 `exists` 中增加有效档位谓词（**含 `tier_expires_at`**），或与独立 `tier_requirements` 映射表关联；可选封装 `security definer` 函数 `effective_user_tier(app_id, env, uid)` 供策略复用（函数置于私有 schema，内部仍只读表）

## API 与服务边界建议

- 客户端直连 Supabase：
  - 读取自己的用户资料、VIP 状态、个人账单
- 服务端（Edge Functions）：
  - 支付回调验签
  - 批量结算与对账
  - 管理后台高权限操作（封禁、调账、授予 VIP）

## 管理后台建议菜单

- 应用管理：应用列表、状态管理、应用配置
- 用户管理：用户检索、封禁解禁、资料查看、行为日志
- 财务管理：账户、流水、对账、提现审核
- VIP 管理：套餐、开通记录、续费记录、过期处理
- 权限管理：角色、权限点、人员授权
- 档位审计：`user_tier_change_logs` 检索（纠纷 / 对账）

## 最小可用版本（MVP）

第一期优先上线：

1. 多应用与用户体系（`apps`, `app_users` 含 `env` 与 `user_tier`, `user_profiles`）；RLS 按 `app_id` + `env` + 档位/RBAC 生效
2. RBAC 权限与后台登录（`roles`/`user_roles` 含 `env`）；终端档位与 `app_metadata` 同步策略（可选）
3. VIP 套餐与开通记录
4. 钱包账户与基础流水

第二期再补充：

- 自动对账
- 实时通知
- 财务报表与导出
- 更细粒度权限（字段级、动作级）
- 团队维度成员表与共享资源的 RLS 策略细化；团队删除级联与资源清理策略复核
- `tier_expires_at` 到期降级任务与审计完整性
