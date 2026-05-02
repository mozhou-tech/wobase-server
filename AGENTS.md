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
- `platform` (text) — `ios` | `android` | `web` | `desktop`，建议 `CHECK (platform IN ('ios','android','web','desktop'))`
- `status` (text) — `active` | `disabled`，建议 `CHECK (status IN ('active','disabled'))`
- `metadata` (jsonb, default '{}') — 应用自定义属性（如主题、logo、描述、扩展配置等），各应用可自由定义内部结构
- `ext_schema_prefix` (text, nullable) — 扩展表命名前缀，如 `myapp`；应用特有业务表建议以此为前缀（如 `myapp_player_levels`），便于识别和管理
- `created_at` (timestamptz)

> 外键级联策略：`apps` 作为根表，通常不允许直接删除（避免级联误删全量业务数据）。若需下线应用，建议标记 `status = 'disabled'`。

### 2) 应用用户绑定

`app_users`

- `id` (uuid, pk)
- `app_id` (uuid, fk -> apps.id, `ON DELETE CASCADE`)
- `user_id` (uuid, fk -> auth.users.id, `ON DELETE CASCADE`)
- `env` (text) — `dev` | `test` | `prod`，建议 `CHECK (env IN ('dev','test','prod'))`
- `user_tier` (text) — `basic` | `paid` | `team`，建议 `CHECK (user_tier IN ('basic','paid','team'))`
- `tier_expires_at` (timestamptz, nullable) — 付费/团队等档位的到期时刻；到期后应在库内降级（见「关键安全原则」），RLS 须结合该字段判断**有效档位**，避免永久授权
- `app_user_status` (text) — `active` | `banned`，建议 `CHECK (app_user_status IN ('active','banned'))`
- `metadata` (jsonb, default '{}') — 用户在该应用下的扩展数据（如游戏进度、应用内偏好、自定义字段等），结构由应用自行约定
- `created_at` (timestamptz)
- unique(`app_id`, `user_id`, `env`)

> 说明：完全独立方案下，同一 `auth.users.id` 在不同应用/环境下拥有**独立的** `user_profiles` 记录。`auth.users` 仅作为认证凭据存储，各应用的用户资料、档位、状态完全隔离。

## 索引与性能设计

以下索引为 RLS 高频查询及业务查询所必需，应在 migrations 中一并创建：

```sql
-- 应用用户查询（RLS 核心）
CREATE INDEX idx_app_users_user_app_env ON app_users(user_id, app_id, env);
CREATE INDEX idx_app_users_tier_expires ON app_users(tier_expires_at) WHERE user_tier IN ('paid','team');

-- 用户资料
CREATE INDEX idx_user_profiles_user_app_env ON user_profiles(user_id, app_id, env);

-- 钱包账户
CREATE INDEX idx_wallet_accounts_user_app_env ON wallet_accounts(user_id, app_id, env);

-- 钱包流水（按业务单号幂等查询）
CREATE INDEX idx_wallet_transactions_biz_no ON wallet_transactions(app_id, env, biz_no);
CREATE INDEX idx_wallet_transactions_user_created ON wallet_transactions(user_id, created_at DESC);

-- VIP 查询（有效 VIP 快速筛选）
CREATE INDEX idx_user_vips_user_app_env_status ON user_vips(user_id, app_id, env, status) WHERE status = 'active';
CREATE INDEX idx_user_vips_end_at ON user_vips(end_at) WHERE status = 'active';

-- RBAC 查询
CREATE INDEX idx_user_roles_user_app_env ON user_roles(user_id, app_id, env);
CREATE INDEX idx_role_permissions_role ON role_permissions(role_id);

-- 审计日志
CREATE INDEX idx_user_status_logs_user_app ON user_status_logs(user_id, app_id, created_at DESC);
CREATE INDEX idx_user_tier_logs_user_app ON user_tier_change_logs(user_id, app_id, env, created_at DESC);
```

> 注意：`unique` 约束会自动创建唯一索引，无需额外声明。

### 3) 应用级配置表

`app_configs`

- `id` (uuid, pk)
- `app_id` (uuid, fk -> apps.id, `ON DELETE CASCADE`)
- `env` (text) — `dev` | `test` | `prod`，`CHECK (env IN ('dev','test','prod'))`
- `config_key` (text) — 配置项标识，如 `theme`、`payment_gateway`、`feature_flags`
- `config_value` (jsonb) — 配置值，各应用自由定义结构
- `is_sensitive` (boolean, default false) — 是否包含密钥等敏感信息；敏感配置不应通过客户端 RLS 直接暴露
- `created_at` (timestamptz)
- `updated_at` (timestamptz)
- unique(`app_id`, `env`, `config_key`)

> 说明：`app_configs` 存储**结构化应用级配置**（如支付渠道参数、功能开关、主题配置等），支持按环境隔离。应用自定义业务数据若超出配置范畴，应创建独立的扩展业务表。

### 4) 应用-用户元数据表（EAV）

`app_user_metadata`

- `id` (uuid, pk)
- `app_id` (uuid, fk -> apps.id, `ON DELETE CASCADE`)
- `user_id` (uuid, fk -> auth.users.id, `ON DELETE CASCADE`)
- `env` (text) — `dev` | `test` | `prod`，`CHECK (env IN ('dev','test','prod'))`
- `meta_key` (text) — 元数据标识，如 `game_level`、`onboarding_step`、`preferences`
- `meta_value` (jsonb) — 元数据值
- `created_at` (timestamptz)
- `updated_at` (timestamptz)
- unique(`app_id`, `user_id`, `env`, `meta_key`)

> 说明：`app_user_metadata` 采用 **EAV（Entity-Attribute-Value）** 模型，为各应用提供**用户级键值对扩展存储**。当 `app_users.metadata` (jsonb) 的单文档查询模式不满足需求（如需按 `meta_key` 筛选、索引或跨用户聚合）时，应使用此表。应用可自由定义 `meta_key` 和 `meta_value` 结构。

### 索引补充（应用元数据相关）

```sql
-- 应用配置查询
CREATE INDEX idx_app_configs_app_env ON app_configs(app_id, env);
CREATE INDEX idx_app_configs_key ON app_configs(config_key);

-- 应用用户元数据查询
CREATE INDEX idx_app_user_metadata_user_app_env ON app_user_metadata(user_id, app_id, env);
CREATE INDEX idx_app_user_metadata_key ON app_user_metadata(meta_key);
```

## 应用元数据与扩展

### 核心设计目标

在统一的多应用后端中，不同应用（如游戏、电商、工具）必然存在**差异化的业务数据**。本方案在保持核心模块（用户、财务、VIP、RBAC）统一的同时，通过以下分层机制支持各应用的个性化扩展：

| 扩展层级 | 载体 | 适用场景 | 数据隔离 |
|----------|------|----------|----------|
| 应用属性 | `apps.metadata` (jsonb) | 应用基本信息扩展（logo、描述、品类标签） | 按 `app_id` |
| 应用配置 | `app_configs` 表 | 结构化配置（支付参数、功能开关、环境变量） | 按 `app_id` + `env` |
| 用户应用数据 | `app_users.metadata` (jsonb) | 轻量用户扩展（简单偏好、一次性状态） | 按 `app_id` + `user_id` + `env` |
| 用户应用元数据 | `app_user_metadata` 表 | 需查询/索引的用户扩展（游戏进度、多步骤引导状态） | 按 `app_id` + `user_id` + `env` |
| 应用特有业务表 | 独立表（命名规范见下文） | 复杂业务实体（游戏关卡、电商订单、文档空间） | 必须含 `app_id` + `env` + RLS |

### 应用特有业务表命名规范

各应用特有的业务数据（超出通用模块范畴），应在统一命名规范下创建独立表：

- **命名格式**：`{ext_schema_prefix}_{entity}`，其中 `ext_schema_prefix` 取自 `apps.ext_schema_prefix`
  - 示例：`mygame_player_levels`、`mygame_achievements`、`myshop_products`
- **必须字段**：`id`、`app_id` (uuid, fk -> apps.id)、`env` (text)、`created_at`
- **必须开启 RLS**：所有应用特有业务表默认开启 RLS，策略需约束 `app_id` + `env` + 资源归属
- **禁止**：动态创建表（如通过客户端请求建表）；所有 schema 变更应通过 **Supabase CLI migrations** 管理

### 应用业务表创建指南

#### 1) 应用注册流程（分配命名空间）

在创建业务表之前，先在 `apps` 表中注册应用并分配扩展前缀：

```sql
INSERT INTO apps (app_key, name, platform, status, ext_schema_prefix)
VALUES ('mygame', '我的游戏', 'ios', 'active', 'mygame');
```

> **命名空间冲突避免**：`ext_schema_prefix` 必须全局唯一。建议在注册应用时通过数据库 `UNIQUE` 约束或应用层校验确保前缀不重复。

#### 2) 迁移脚本模板

每个应用的业务表应存放在独立的迁移脚本中，文件命名规范：`{timestamp}_{app_prefix}_{entity}.sql`

示例：`20240115_mygame_player_levels.sql`

```sql
-- ============================================
-- 应用：mygame
-- 表：mygame_player_levels（玩家关卡进度）
-- ============================================

CREATE TABLE mygame_player_levels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  env text NOT NULL CHECK (env IN ('dev', 'test', 'prod')),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  level_id int NOT NULL,
  score int NOT NULL DEFAULT 0,
  stars int NOT NULL DEFAULT 0 CHECK (stars >= 0 AND stars <= 3),
  completed_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  
  -- 同一用户在同一应用同一环境下，同一关卡只有一条记录
  UNIQUE(app_id, env, user_id, level_id)
);

-- 必要索引
CREATE INDEX idx_mygame_player_levels_user_app_env 
  ON mygame_player_levels(user_id, app_id, env);
CREATE INDEX idx_mygame_player_levels_level 
  ON mygame_player_levels(app_id, env, level_id);

-- 更新时间戳触发器（可选）
CREATE TRIGGER update_mygame_player_levels_updated_at
  BEFORE UPDATE ON mygame_player_levels
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- 启用 RLS
ALTER TABLE mygame_player_levels ENABLE ROW LEVEL SECURITY;

-- 策略 1：用户只能读写自己的记录（且 env 匹配）
CREATE POLICY "mygame_player_levels_self_access"
  ON mygame_player_levels
  FOR ALL
  USING (
    user_id = auth.uid()
    AND env = (auth.jwt()->'app_metadata'->>'env')
  )
  WITH CHECK (
    user_id = auth.uid()
    AND env = (auth.jwt()->'app_metadata'->>'env')
  );

-- 策略 2：管理员可按应用查询（通过 RBAC 校验）
CREATE POLICY "mygame_player_levels_admin_access"
  ON mygame_player_levels
  FOR ALL
  USING (
    env = (auth.jwt()->'app_metadata'->>'env')
    AND EXISTS (
      SELECT 1 FROM user_roles ur
      JOIN roles r ON ur.role_id = r.id
      WHERE ur.user_id = auth.uid()
        AND ur.app_id = mygame_player_levels.app_id
        AND ur.env = mygame_player_levels.env
    )
  );
```

#### 3) RLS 策略规范（应用业务表通用模板）

所有应用业务表的 RLS 策略应遵循以下模板：

```sql
-- 通用用户策略（必须）
CREATE POLICY "{table}_user_access"
  ON {table}
  FOR ALL
  USING (
    -- 资源归属校验
    user_id = auth.uid()
    -- 环境隔离
    AND env = (auth.jwt()->'app_metadata'->>'env')
    -- 应用成员关系校验（可选，增加安全性）
    AND EXISTS (
      SELECT 1 FROM app_users au
      WHERE au.app_id = {table}.app_id
        AND au.env = {table}.env
        AND au.user_id = auth.uid()
        AND au.app_user_status = 'active'
    )
  );

-- 通用管理员策略（可选）
CREATE POLICY "{table}_admin_access"
  ON {table}
  FOR ALL
  USING (
    env = (auth.jwt()->'app_metadata'->>'env')
    AND EXISTS (
      SELECT 1 FROM user_roles ur
      JOIN roles r ON ur.role_id = r.id
      WHERE ur.user_id = auth.uid()
        AND ur.app_id = {table}.app_id
        AND ur.env = {table}.env
    )
  );
```

#### 4) 应用层对接规范

客户端调用时应始终携带当前应用标识，推荐方式：

```javascript
// 客户端初始化时绑定应用
const supabase = createClient(url, anonKey, {
  db: {
    schema: 'public'
  },
  global: {
    headers: {
      'x-app-id': 'mygame-uuid',      // 应用 ID
      'x-env': 'prod'                 // 当前环境
    }
  }
});

// 查询本应用的业务数据（RLS 自动过滤）
const { data } = await supabase
  .from('mygame_player_levels')
  .select('*')
  .eq('level_id', 1);
```

> **注意**：虽然可通过 HTTP Header 传递 `app_id`，但 RLS 策略中**不应直接信任 Header**，仍应以 JWT 中的 `app_metadata` 或 `auth.uid()` 关联的 `app_users` 记录为准，防止伪造。

#### 5) 命名空间管理清单

建议在项目中维护以下清单，避免表名冲突：

| 应用 | `app_key` | `ext_schema_prefix` | 扩展表清单 |
|------|----------|---------------------|-----------|
| 我的游戏 | `mygame` | `mygame` | `mygame_player_levels`, `mygame_achievements` |
| 我的商城 | `myshop` | `myshop` | `myshop_products`, `myshop_orders` |

> 冲突解决：若两个应用申请相同前缀，以先注册者为准。前缀一旦分配，即使应用下线也不应回收重用（避免历史数据混淆）。

### 元数据扩展的选型建议

- **jsonb 字段（`apps.metadata`、`app_users.metadata`）**：
  - ✅ 适合不需要按内部字段筛选/聚合的数据
  - ✅ 读写简单，无需 join
  - ❌ 不适合高频按 key 查询或跨用户统计

- **独立 EAV 表（`app_user_metadata`）**：
  - ✅ 支持按 `meta_key` 索引和查询
  - ✅ 支持跨用户聚合（如统计完成某引导步骤的用户数）
  - ❌ 数据分散在多行，读取完整用户画像需要多次查询

- **独立业务表**：
  - ✅ 适合复杂实体关系、外键约束、强类型查询
  - ✅ 可充分利用 Postgres 索引和约束
  - ❌ 需要维护 migrations，灵活性最低

**建议**：单个应用的元数据项少于 20 个且结构简单 → `jsonb`；需要索引/聚合 → EAV 表；复杂业务实体 → 独立表。

### RLS 策略（应用元数据）

`app_configs`：
- 普通用户：通常**不可读**敏感配置（`is_sensitive = true`）；非敏感配置可按应用读取
- 管理员：通过 `user_roles` + `app_id` + `env` 读取/写入

`app_user_metadata`：
- 普通用户：只能读写自己的元数据（`user_id = auth.uid()`），且 `env` 一致
- 管理员：可按应用、按用户查询（用于运营支持）

应用特有业务表：
- 必须遵循 `app_id` + `env` + 资源归属的 RLS 约束
- 建议通过 `apps.ext_schema_prefix` 在文档中记录各应用的扩展表清单，便于权限审计

## 环境与数据隔离（dev / test / prod）

业务数据除按 **应用（`app_id`）** 隔离外，还需按 **运行环境** 隔离，避免测试或开发数据与生产混读混写。

### 环境枚举

使用 Postgres 枚举或 `text` + 校验约束，取值固定为：`dev`、`test`、`prod`。

### 表设计约定

凡面向客户端或面向运营后台、且需区分环境的数据表，增加列：

- `env` (text 或 app_environment enum) — `dev` | `test` | `prod`，**必须**带 `CHECK (env IN ('dev','test','prod'))`

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

- `id` (uuid, pk)
- `app_id` (uuid, fk -> apps.id, `ON DELETE CASCADE`) — 应用标识，用户资料按应用隔离
- `env` (text) — `dev`/`test`/`prod`，`CHECK (env IN ('dev','test','prod'))` — 环境标识
- `user_id` (uuid, fk -> auth.users.id, `ON DELETE CASCADE`) — Supabase Auth 用户标识
- `display_name` (text)
- `avatar_url` (text)
- `phone` (text)
- `country_code` (text)
- `metadata` (jsonb, default '{}') — 用户资料扩展字段，结构由应用自行约定
- `created_at` (timestamptz)
- `updated_at` (timestamptz)
- unique(`app_id`, `env`, `user_id`)

> **注意**：完全独立方案下，同一 `auth.users.id` 在不同应用/环境下拥有**独立的** `user_profiles` 记录。`auth.users` 仅作为认证凭据存储，各应用的用户资料、档位、状态完全隔离。

`user_status_logs`

- `id` (uuid, pk)
- `app_id` (uuid, fk -> apps.id, `ON DELETE CASCADE`)
- `env` (text) — `dev`/`test`/`prod`，`CHECK (env IN ('dev','test','prod'))`
- `user_id` (uuid, fk -> auth.users.id, `ON DELETE CASCADE`)
- `action` (text) — `create` | `ban` | `unban` | `delete`，`CHECK (action IN ('create','ban','unban','delete'))`
- `old_status` (text, nullable) — 变更前状态，便于审计追溯
- `new_status` (text, nullable) — 变更后状态
- `operator_user_id` (uuid, nullable)
- `remark` (text)
- `created_at` (timestamptz)

### 功能点

- 用户查询（按 app、状态、时间、关键词）
- 用户封禁/解禁
- 用户资料维护
- 用户操作审计日志（含变更前后值）

## 财务管理模块

### 核心表

`wallet_accounts`

- `id` (uuid, pk)
- `app_id` (uuid, fk -> apps.id, `ON DELETE CASCADE`)
- `user_id` (uuid, fk -> auth.users.id, `ON DELETE CASCADE`)
- `env` (text) — `dev`/`test`/`prod`，`CHECK (env IN ('dev','test','prod'))`
- `currency` (text) — `CNY` | `USD` | `points`，建议 `CHECK (currency IN ('CNY','USD','points'))`
- `available_balance` (numeric(18,2)) — **必须 >= 0**，建议 `CHECK (available_balance >= 0)`
- `frozen_balance` (numeric(18,2)) — **必须 >= 0**，建议 `CHECK (frozen_balance >= 0)`
- `updated_at` (timestamptz)
- unique(`app_id`, `user_id`, `currency`, `env`)

`wallet_transactions`

- `id` (uuid, pk)
- `app_id` (uuid, fk -> apps.id, `ON DELETE CASCADE`)
- `env` (text) — `dev`/`test`/`prod`，`CHECK (env IN ('dev','test','prod'))`
- `user_id` (uuid, fk -> auth.users.id, `ON DELETE CASCADE`)
- `account_id` (uuid, fk -> wallet_accounts.id, `ON DELETE CASCADE`)
- `biz_type` (text) — `recharge` | `consume` | `refund` | `settle` | `withdraw`，建议 `CHECK (...)`
- `amount` (numeric(18,2)) — **必须 > 0**，建议 `CHECK (amount > 0)`
- `direction` (text) — `in` | `out`，`CHECK (direction IN ('in','out'))`
- `status` (text) — `pending` | `success` | `failed`，`CHECK (status IN ('pending','success','failed'))`
- `biz_no` (text) — 业务方唯一单号，用于幂等控制，**必须** `unique(app_id, env, biz_no)`
- `ext` (jsonb)
- `created_at` (timestamptz)

### 并发控制与余额安全

余额变更是高并发敏感操作，必须避免竞态条件导致**超扣**或**负余额**。推荐两种实现方案：

**方案 A：数据库原子函数（推荐）**

封装 `SECURITY DEFINER` 函数，内部使用 `SELECT ... FOR UPDATE` 或原子 `UPDATE ... WHERE available_balance >= ?`：

```sql
-- 示例：扣款函数（伪代码）
CREATE OR REPLACE FUNCTION deduct_balance(
  p_account_id uuid,
  p_amount numeric(18,2),
  p_biz_no text
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_app_id uuid;
  v_env text;
  v_user_id uuid;
BEGIN
  -- 1. 加锁读取并校验余额
  SELECT app_id, env, user_id, available_balance
  INTO v_app_id, v_env, v_user_id
  FROM wallet_accounts
  WHERE id = p_account_id
  FOR UPDATE;
  
  -- 2. 原子扣减（若余额不足则返回 0 行，事务安全）
  UPDATE wallet_accounts
  SET available_balance = available_balance - p_amount,
      updated_at = now()
  WHERE id = p_account_id
    AND available_balance >= p_amount;
    
  IF NOT FOUND THEN
    RETURN false; -- 余额不足
  END IF;
  
  -- 3. 写入流水
  INSERT INTO wallet_transactions (
    app_id, env, user_id, account_id, biz_type, amount, direction, status, biz_no
  ) VALUES (
    v_app_id, v_env, v_user_id, p_account_id, 'consume', p_amount, 'out', 'success', p_biz_no
  );
  
  RETURN true;
END;
$$;
```

**方案 B：应用层乐观锁**

`wallet_accounts` 增加 `version` (int) 字段，更新时 `WHERE version = old_version`。

> **原则**：所有财务写操作（扣款、退款、冻结）**禁止**由客户端直接 `UPDATE` 余额表，必须通过上述受控函数/事务完成。

### 建议

- 账务只追加流水，不直接改历史记录
- 余额变更通过数据库函数或事务统一处理
- `biz_no` 必须保证幂等（同一 `app_id+env+biz_no` 不可重复入账/出账）
- 对账任务建议通过 Edge Functions + Cron 触发

## VIP 管理模块

### 核心表

`vip_plans`

- `id` (uuid, pk)
- `app_id` (uuid, fk -> apps.id, `ON DELETE CASCADE`)
- `env` (text) — `dev`/`test`/`prod`，`CHECK (env IN ('dev','test','prod'))`
- `name` (text)
- `level` (int)
- `price` (numeric(18,2))
- `duration_days` (int)
- `benefits` (jsonb)
- `status` (text) — `active` | `inactive`，`CHECK (status IN ('active','inactive'))`

> `vip_plans` 通常作为配置表，**不建议**物理删除已创建套餐（避免已售记录悬空）。如需停用，标记 `status = 'inactive'`。

`user_vips`

- `id` (uuid, pk)
- `app_id` (uuid, fk -> apps.id, `ON DELETE CASCADE`)
- `env` (text) — `dev`/`test`/`prod`，`CHECK (env IN ('dev','test','prod'))`
- `user_id` (uuid, fk -> auth.users.id, `ON DELETE CASCADE`)
- `plan_id` (uuid, fk -> vip_plans.id, `ON DELETE RESTRICT`) — 已关联销售的套餐不允许删除
- `start_at` (timestamptz)
- `end_at` (timestamptz)
- `status` (text) — `active` | `expired` | `cancelled`，`CHECK (status IN ('active','expired','cancelled'))`
- `source` (text) — `purchase` | `admin_grant` | `activity`，`CHECK (source IN ('purchase','admin_grant','activity'))`

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

### 到期降级落地机制

仅靠字段声明无法保证降级执行，必须配套以下机制：

1. **RLS 实时计算（第一道防线）**
   所有受档位控制的 RLS 策略中，必须使用**有效档位表达式**，而非直接读取 `user_tier`：

   ```sql
   -- 在 RLS USING / WITH CHECK 中嵌入
   AND EXISTS (
     SELECT 1 FROM app_users au
     WHERE au.app_id = <table>.app_id
       AND au.env = <table>.env
       AND au.user_id = auth.uid()
       AND (
         au.user_tier = 'basic'
         OR (
           au.user_tier IN ('paid','team')
           AND (au.tier_expires_at IS NULL OR au.tier_expires_at > now())
         )
       )
   )
   ```

2. **定时补偿修正（第二道防线）**
   使用 **pg_cron**（Supabase 支持）或 **Edge Function + Cron Trigger**，定期扫描过期记录并修正：

   ```sql
   -- pg_cron 示例：每 5 分钟扫描并降级
   SELECT cron.schedule('tier-downgrade', '*/5 * * * *', $$
     UPDATE app_users
     SET user_tier = 'basic',
         tier_expires_at = NULL,
         updated_at = now()
     WHERE user_tier IN ('paid','team')
       AND tier_expires_at IS NOT NULL
       AND tier_expires_at <= now()
   $$);
   ```
   每次降级必须同步写入 `user_tier_change_logs`。

3. **可选：封装复用函数**
   将有效档位判断封装为 `SECURITY DEFINER` 函数，供 RLS 与业务层复用：

   ```sql
   CREATE OR REPLACE FUNCTION effective_user_tier(
     p_app_id uuid,
     p_env text,
     p_user_id uuid
   ) RETURNS text
   LANGUAGE sql STABLE SECURITY DEFINER
   AS $$
     SELECT CASE
       WHEN au.user_tier IN ('paid','team')
            AND (au.tier_expires_at IS NULL OR au.tier_expires_at > now())
       THEN au.user_tier
       ELSE 'basic'
     END
     FROM app_users au
     WHERE au.app_id = p_app_id
       AND au.env = p_env
       AND au.user_id = p_user_id;
   $$;
   ```

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
- `reason` (text) — `purchase_expire` | `admin_adjust` | `refund` | `team_dissolve` 等
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
- `app_id` (uuid, fk -> apps.id, `ON DELETE CASCADE`)
- `env` (text) — `dev`/`test`/`prod`，`CHECK (env IN ('dev','test','prod'))`
- `code` (text) — `super_admin` | `finance` | `vip_operator` | `support`
- `name` (text)
- unique(`app_id`, `code`, `env`)

`permissions`

- `id` (uuid, pk)
- `code` (text, **全局 unique**) — `user.read`, `user.ban`, `finance.read`, `vip.write`
- `name` (text)

> **约定**：`permissions` 采用**全局统一权限码**命名空间。所有应用共享同一套权限语义（如 `user.read` 始终表示「读取用户列表」）。若未来某应用需要特殊粒度，应在 `permissions.code` 中通过前缀区分（如 `app_a.data.export`），而非按 `app_id` 隔离权限定义。

`role_permissions`

- `role_id` (uuid, fk -> roles.id, `ON DELETE CASCADE`)
- `permission_id` (uuid, fk -> permissions.id, `ON DELETE CASCADE`)
- unique(`role_id`, `permission_id`)

`user_roles`

- `app_id` (uuid, fk -> apps.id, `ON DELETE CASCADE`)
- `env` (text) — `dev`/`test`/`prod`，`CHECK (env IN ('dev','test','prod'))`
- `user_id` (uuid, fk -> auth.users.id, `ON DELETE CASCADE`)
- `role_id` (uuid, fk -> roles.id, `ON DELETE CASCADE`)
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
4. 普通用户只能访问**自己所属应用**下的用户资料、钱包、VIP 数据（`app_id` 与 `env` 均须一致）；团队场景扩展为「本人或本团队成员」
5. 管理员角色可按权限访问 **同一应用、同一环境** 内的数据（`user_roles`）
6. 财务相关写操作必须通过受控函数执行

示例（思路）：

- `using (exists (select 1 from app_users au where au.app_id = <table>.app_id and au.env = <table>.env and au.user_id = auth.uid()))`
- 并与 `auth.jwt()` 中解析出的 `env` 做交叉校验，避免仅依赖表内列被篡改的假设（插入/更新策略需约束 `env` 不可改为与 JWT 不一致的值）
- 需要档位时：在上述 `exists` 中增加有效档位谓词（**含 `tier_expires_at`**），或与独立 `tier_requirements` 映射表关联；可选封装 `security definer` 函数 `effective_user_tier(app_id, env, uid)` 供策略复用（函数置于私有 schema，内部仍只读表）

### Realtime 订阅安全

Supabase Realtime 的 `postgres_changes` 监听与 Postgres RLS **是两套独立机制**。在启用 Realtime 推送时，必须额外约束订阅范围：

- **客户端订阅**必须绑定 `user_id = auth.uid()` 与 `env` 过滤，禁止全表监听：

  ```javascript
  // 正确示例
  supabase.channel('wallet')
    .on('postgres_changes', {
      event: 'INSERT',
      schema: 'public',
      table: 'wallet_transactions',
      filter: `user_id=eq.${currentUserId}` // 必须显式过滤
    }, callback)
    .subscribe();
  ```

- **RLS 补充**：即使 Realtime 侧过滤正确，Postgres 侧的 RLS 仍必须生效（Realtime 会使用 RLS 做行级过滤）。确保 `wallet_transactions` 等表的 RLS `SELECT` 策略已限制 `user_id = auth.uid()`。
- **避免敏感字段泄露**：Realtime 推送会携带整行数据，确保业务表中不含明文密码、密钥等敏感列。

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

## 运维与合规

### 数据库迁移（Migrations）

- 使用 **Supabase CLI** 管理 schema 变更（`supabase db diff` / `supabase db push`），禁止手动在 Dashboard 中修改生产环境表结构。
- 迁移脚本必须包含：表结构、约束（CHECK / UNIQUE / FK）、索引、RLS 策略、函数（如有）。
- 单库多环境方案下，迁移脚本应**无条件应用于所有环境**（`env` 列本身区分数据，schema 保持一致）。

### 备份与恢复

- 单库多环境：Supabase 自动备份为整库级别，无法单独恢复某个环境的数据。如需环境级隔离恢复，建议在应用层实现数据导出/导入工具。
- 每个环境一个 Supabase 项目：备份/恢复天然隔离，推荐对生产环境采用此方案。

### Rate Limiting 与防刷

- **支付回调（Edge Functions）**：必须实现幂等校验（`biz_no` 去重）和请求签名验证，防止重放攻击。
- **登录/注册接口**：利用 Supabase Auth 内置的 rate limiting（如邮件验证码频次限制）。
- **自定义 API（Edge Functions）**：对敏感操作（如高频查询、批量导出）增加 IP / 用户级 rate limiting，可使用 Cloudflare Workers 或 Edge Function 内部计数器。

### Service Role Key 安全

- `service_role` key 拥有绕过 RLS 的特权，**严禁**暴露给客户端。
- 应通过环境变量注入 Edge Functions / 服务端，不在代码仓库中硬编码。
- 定期轮换（Supabase Dashboard 可重置）。

## 最小可用版本（MVP）

第一期优先上线：

1. 多应用与用户体系（`apps`, `app_users` 含 `env` 与 `user_tier`, `user_profiles`）；RLS 按 `app_id` + `env` + 档位/RBAC 生效
2. RBAC 权限与后台登录（`roles`/`user_roles` 含 `env`）；终端档位与 `app_metadata` 同步策略（可选）
3. VIP 套餐与开通记录
4. 钱包账户与基础流水（含余额变更函数与 `biz_no` 幂等）
5. 应用元数据扩展体系（`apps.metadata`, `app_users.metadata`, `app_configs`, `app_user_metadata`）及扩展表命名规范

第二期再补充：

- 自动对账
- 实时通知（Realtime，含安全订阅范围配置）
- 财务报表与导出
- 更细粒度权限（字段级、动作级）
- 团队维度成员表与共享资源的 RLS 策略细化；团队删除级联与资源清理策略复核
- `tier_expires_at` 到期降级任务（pg_cron / Edge Function Cron）与审计完整性
