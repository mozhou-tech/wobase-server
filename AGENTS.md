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
- `platform` (text) — `ios` | `android` | `web` | `desktop`，建议 `CHECK (platform IN ('ios','android','web','desktop'))`；若同一产品多端共用一条 `apps` 记录，可将具体端类型放入 `metadata`（如 `{ "clients": ["ios","android"] }`），避免同一 `app_key` 拆多条应用行
- `status` (text) — `active` | `disabled`，建议 `CHECK (status IN ('active','disabled'))`
- `metadata` (jsonb, default '{}') — 应用自定义属性（如主题、logo、描述、扩展配置等），各应用可自由定义内部结构
- `ext_schema_prefix` (text, nullable) — 扩展表命名前缀，如 `myapp`；应用特有业务表建议以此为前缀（如 `myapp_player_levels`），便于识别和管理
- `created_at` (timestamptz)

> 外键级联策略：`apps` 作为根表，通常不允许直接删除（避免级联误删全量业务数据）。若需下线应用，建议标记 `status = 'disabled'`。

### 2) 应用用户绑定

`app_users`

- `id` (uuid, pk)
- `app_id` (uuid, fk -> apps.id, `ON DELETE CASCADE`)
- `user_id` (uuid, fk -> auth.users.id, `ON DELETE RESTRICT`) — **禁止级联删除**，防止在 Supabase Auth 中误删用户时连带删除该用户在所有应用的数据
- `env` (text) — `dev` | `test` | `prod`，建议 `CHECK (env IN ('dev','test','prod'))`
- `user_tier` (text) — `basic` | `paid` | `team`，建议 `CHECK (user_tier IN ('basic','paid','team'))`
- `tier_expires_at` (timestamptz, nullable) — 付费/团队等档位的到期时刻；到期后应在库内降级（见「关键安全原则」），RLS 须结合该字段判断**有效档位**，避免永久授权
- `app_user_status` (text) — `active` | `banned` | `deleted`（按应用注销流程的**软删除**，与「关键安全原则」一致），建议 `CHECK (app_user_status IN ('active','banned','deleted'))`
- `metadata` (jsonb, default '{}') — 用户在该应用下的扩展数据（如游戏进度、应用内偏好、自定义字段等），结构由应用自行约定
- `created_at` (timestamptz)
- unique(`app_id`, `user_id`, `env`)

> 说明：完全独立方案下，同一 `auth.users.id` 在不同应用/环境下拥有**独立的** `user_profiles` 记录。`auth.users` 仅作为认证凭据存储，各应用的用户资料、档位、状态完全隔离。

## 索引与性能设计

以下索引为 RLS 高频查询及业务查询所必需，应在 migrations 中一并创建：

```sql
-- 应用用户查询（RLS 核心）
CREATE INDEX idx_app_users_user_app_env ON app_users(user_id, app_id, env);
-- 定时任务扫描「将到期/已到期」档位时，可仅索引需处理行（按需调整谓词）
CREATE INDEX idx_app_users_tier_expires ON app_users(tier_expires_at)
  WHERE user_tier IN ('paid','team') AND tier_expires_at IS NOT NULL;

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

-- 团队席位制 VIP（启用该模块时创建）
CREATE INDEX idx_team_vip_subs_team_app_env ON team_vip_subscriptions(team_id, app_id, env);
CREATE INDEX idx_team_vip_subs_active_window ON team_vip_subscriptions(app_id, env, end_at)
  WHERE status = 'active';
CREATE INDEX idx_team_vip_seats_sub_active ON team_vip_seat_assignments(subscription_id)
  WHERE status = 'active';
CREATE INDEX idx_team_vip_seats_user_app_env ON team_vip_seat_assignments(user_id, app_id, env)
  WHERE status = 'active';

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
- `user_id` (uuid, fk -> auth.users.id, `ON DELETE RESTRICT`) — **禁止级联删除**，与 `app_users` 策略一致
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

## 数据库基础设施函数

以下函数为 migrations 中必须预先创建的基础工具函数，供触发器、RLS 策略及业务层复用。

### 自动更新时间戳

```sql
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
```

### 有效用户档位计算

```sql
CREATE OR REPLACE FUNCTION effective_user_tier(
  p_app_id uuid,
  p_env text,
  p_user_id uuid
) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
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
    AND au.user_id = p_user_id
    AND au.app_user_status = 'active';
$$;
```

> **注意**：`SECURITY DEFINER` 函数必须显式 `SET search_path = public`，防止 search_path 注入攻击（恶意用户通过同名表劫持函数）。所有置于私有 schema 的受控函数均应遵循此规范。
>
> **权限控制**：`REVOKE ALL ON FUNCTION effective_user_tier(uuid, text, uuid) FROM PUBLIC;`，仅 `GRANT EXECUTE` 给 `service_role` 或 postgres。若对 `authenticated` 开放，理论上用户可通过遍历参数探测其他用户的档位信息。
>
> **非 active 成员**：`banned` / `deleted` 不满足上述 `WHERE`，函数返回 **NULL**（调用方勿把 NULL 当成 `basic`）；RLS 与档位判断应以「成员存在且 `active`」为前提。

### 档位写回：`recompute_app_user_tier`（强烈推荐）

`effective_user_tier` 仅 **读取** `app_users` 已落库的枚举；**团队席位 + 个人 VIP** 并存时，`user_tier` / `tier_expires_at` 的权威来源是多张业务表，应在单一 **`SECURITY DEFINER`** 函数内合成并 **写回 `app_users`**，避免 Edge 与 Cron 各写一套逻辑。

**签名（示意，表就绪后在 migrations 中创建）**

```text
recompute_app_user_tier(
  p_app_id uuid,
  p_env text,
  p_user_id uuid,
  p_reason text DEFAULT NULL,
  p_operator_user_id uuid DEFAULT NULL
) RETURNS void
```

**语义**

1. 若不存在 `app_users(app_id, env, user_id)` 或 **`app_user_status <> 'active'`**，直接 **RETURN**（不写删档用户）。
2. **`v_team_exp`**：`team_vip_seat_assignments.status = 'active'` 且关联 **`team_vip_subscriptions`** 满足 `subscriptions.status = 'active'` 且 `now()` 落在 `[start_at, end_at]`（边界开合按产品约定），取 **`MAX(subscriptions.end_at)`**。
3. **`v_paid_exp`**：`user_vips.status = 'active'` 且 `end_at > now()`，取 **`MAX(end_at)`**（与个人多条 VIP 约定一致）。
4. **默认优先级**（与 VIP 小节「`paid` 与 `team` 并存」一致）：若 `v_team_exp IS NOT NULL` → `user_tier = 'team'`，`tier_expires_at = v_team_exp`；否则若 `v_paid_exp IS NOT NULL` → **`paid`** / **`v_paid_exp`**；否则 **`basic`** / **`tier_expires_at = NULL`**。
  5. 若 `(user_tier, tier_expires_at)` 与当前行 **任一变化**，在同一事务内 **`UPDATE app_users`**，并 **`INSERT user_tier_change_logs`**（`old_*` / `new_*`、`reason` 可用 `p_reason` 或细分枚举）。
6. **JWT**：若项目依赖 `app_metadata.tier` 镜像，须在调用链末端（Edge Admin API）触发刷新；数据库函数本身不刷新 JWT。

**并发**：可被多条 Edge 路径并发调用；以 **`UPDATE app_users WHERE ...`** 单行更新为主，幂等（重复计算得到相同结果则无日志）。

**权限**：`REVOKE ALL ON FUNCTION recompute_app_user_tier(...) FROM PUBLIC`；仅 **`service_role`** 或 **`postgres`**（含 Edge 使用的服务端连接）具备 `EXECUTE`。客户端禁止直连调用。

**调用时机（备忘）**

| 触发场景 | 调用方 |
|---------|--------|
| 分配 / 撤销席位、订阅生效或解约 | Edge（席位事务末尾） |
| `user_vips` 开通 / 退款 / 过期回调 | Edge |
| 批量订阅到期 Cron | 对每个受影响 `user_id` 调用（或由 SQL 批量 `SELECT DISTINCT user_id ...` 循环） |
| 定时降级任务 | **优先**对本函数扫描出的候选用户调用，而不是仅 `UPDATE ... SET basic` 一刀切（否则团队过期后仍可能有有效 **paid**） |

产品若启用 **`paid` 优先于 `team`**，在本函数内 **调换分支顺序** 即可，并保持 VIP 小节表格与代码同步。

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
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT, -- 禁止级联删除，与 app_users 策略一致
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

-- 策略 1：用户只能读写自己的记录（env + active 成员关系，与通用模板一致）
CREATE POLICY "mygame_player_levels_self_access"
  ON mygame_player_levels
  FOR ALL
  USING (
    (auth.jwt()->'app_metadata'->>'env') IS NOT NULL
    AND (auth.jwt()->'app_metadata'->>'env') IN ('dev', 'test', 'prod')
    AND user_id = auth.uid()
    AND env = (auth.jwt()->'app_metadata'->>'env')
    AND EXISTS (
      SELECT 1 FROM app_users au
      WHERE au.app_id = mygame_player_levels.app_id
        AND au.env = mygame_player_levels.env
        AND au.user_id = auth.uid()
        AND au.app_user_status = 'active'
    )
  )
  WITH CHECK (
    (auth.jwt()->'app_metadata'->>'env') IS NOT NULL
    AND (auth.jwt()->'app_metadata'->>'env') IN ('dev', 'test', 'prod')
    AND user_id = auth.uid()
    AND env = (auth.jwt()->'app_metadata'->>'env')
    AND EXISTS (
      SELECT 1 FROM app_users au
      WHERE au.app_id = mygame_player_levels.app_id
        AND au.env = mygame_player_levels.env
        AND au.user_id = auth.uid()
        AND au.app_user_status = 'active'
    )
  );

-- 策略 2：管理员可按应用查询（RBAC；生产建议链到 permissions，见「管理员 RLS 与 permissions」）
CREATE POLICY "mygame_player_levels_admin_access"
  ON mygame_player_levels
  FOR ALL
  USING (
    (auth.jwt()->'app_metadata'->>'env') IS NOT NULL
    AND (auth.jwt()->'app_metadata'->>'env') IN ('dev', 'test', 'prod')
    AND env = (auth.jwt()->'app_metadata'->>'env')
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
    -- 防御：JWT 中 env 缺失或非法时拒绝访问
    (auth.jwt()->'app_metadata'->>'env') IS NOT NULL
    AND (auth.jwt()->'app_metadata'->>'env') IN ('dev', 'test', 'prod')
    -- 资源归属校验
    AND user_id = auth.uid()
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
  )
  WITH CHECK (
    (auth.jwt()->'app_metadata'->>'env') IS NOT NULL
    AND (auth.jwt()->'app_metadata'->>'env') IN ('dev', 'test', 'prod')
    AND user_id = auth.uid()
    AND env = (auth.jwt()->'app_metadata'->>'env')
    AND EXISTS (
      SELECT 1 FROM app_users au
      WHERE au.app_id = {table}.app_id
        AND au.env = {table}.env
        AND au.user_id = auth.uid()
        AND au.app_user_status = 'active'
    )
  );

-- 通用管理员策略（可选；上线前改为 EXISTS → permissions，见 RBAC 小节）
CREATE POLICY "{table}_admin_access"
  ON {table}
  FOR ALL
  USING (
    (auth.jwt()->'app_metadata'->>'env') IS NOT NULL
    AND (auth.jwt()->'app_metadata'->>'env') IN ('dev', 'test', 'prod')
    AND env = (auth.jwt()->'app_metadata'->>'env')
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

**双机制边界**：`app_users.metadata` 与 `app_user_metadata` 表可以共存，但应用应约定同一 `meta_key` **不同时**出现在两个载体中。初始化流程建议：
1. 轻量偏好（如 `theme`, `locale`）→ 写入 `app_users.metadata`
2. 需要按 key 查询或跨用户统计的字段（如 `onboarding_step`, `game_level`）→ 写入 `app_user_metadata` 表
3. 初始化应在 `join_app` Edge Function 中统一完成，避免客户端直接操作

### RLS 策略（应用元数据）

`app_configs`：
- 普通用户：通常**不可读**敏感配置（`is_sensitive = true`）；非敏感配置可按应用读取
- 管理员：通过 `user_roles` + `app_id` + `env` 读取/写入

```sql
-- 普通用户：仅可读非敏感配置
CREATE POLICY "app_configs_user_read"
  ON app_configs
  FOR SELECT
  USING (
    (auth.jwt()->'app_metadata'->>'env') IS NOT NULL
    AND (auth.jwt()->'app_metadata'->>'env') IN ('dev', 'test', 'prod')
    AND env = (auth.jwt()->'app_metadata'->>'env')
    AND is_sensitive = false
    AND EXISTS (
      SELECT 1 FROM app_users au
      WHERE au.app_id = app_configs.app_id
        AND au.env = app_configs.env
        AND au.user_id = auth.uid()
        AND au.app_user_status = 'active'
    )
  );

-- 管理员：可读写全部配置（含敏感）
CREATE POLICY "app_configs_admin_all"
  ON app_configs
  FOR ALL
  USING (
    (auth.jwt()->'app_metadata'->>'env') IS NOT NULL
    AND (auth.jwt()->'app_metadata'->>'env') IN ('dev', 'test', 'prod')
    AND env = (auth.jwt()->'app_metadata'->>'env')
    AND EXISTS (
      SELECT 1 FROM user_roles ur
      JOIN role_permissions rp ON rp.role_id = ur.role_id
      JOIN permissions perm ON perm.id = rp.permission_id
      WHERE ur.user_id = auth.uid()
        AND ur.app_id = app_configs.app_id
        AND ur.env = app_configs.env
        AND perm.code = 'app_config.write'
    )
  );
```

`app_user_metadata`：
- 普通用户：只能读写自己的元数据（`user_id = auth.uid()`），且 `env` 一致
- 管理员：可按应用、按用户查询（用于运营支持）

```sql
-- 普通用户
CREATE POLICY "app_user_metadata_self"
  ON app_user_metadata
  FOR ALL
  USING (
    (auth.jwt()->'app_metadata'->>'env') IS NOT NULL
    AND (auth.jwt()->'app_metadata'->>'env') IN ('dev', 'test', 'prod')
    AND user_id = auth.uid()
    AND env = (auth.jwt()->'app_metadata'->>'env')
    AND EXISTS (
      SELECT 1 FROM app_users au
      WHERE au.app_id = app_user_metadata.app_id
        AND au.env = app_user_metadata.env
        AND au.user_id = auth.uid()
        AND au.app_user_status = 'active'
    )
  );
```

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

**默认架构：单库多环境（推荐）**

本方案默认采用**单库多环境**架构，即 dev / test / prod 共用同一 Supabase 项目，由数据行的 `env` 列区分环境。此方案便于跨环境数据比对和迁移，且 `env` 列是 RLS 环境隔离的必要条件。

若 **每个环境一个 Supabase 项目**（多项目方案）：库内可省略 `env` 列（环境即项目边界），但此时所有依赖 `env` 的 RLS 策略、唯一约束和索引均需重写。选择多项目方案时，必须完整调整本文档中所有涉及 `env` 的 SQL 模板。

### 请求上下文：JWT 中携带当前环境（供 RLS 使用）

RLS 需要知道「当前会话要访问哪一套环境的数据」。推荐：

1. 在 **服务端或 Edge Function** 签发/刷新会话时，将当前环境写入 **`auth.users` 的 `app_metadata`（或等价不可由终端用户随意篡改的声明）**，例如 `app_metadata.env = 'prod'`。
2. **不要**用 `user_metadata` 做授权依据（用户可自行修改，不适合作为 RLS 条件）。

在策略中读取示例（思路）：

- `current_setting('request.jwt.claims', true)::json->'app_metadata'->>'env'`
- 或使用 Supabase 文档推荐的 `auth.jwt()` 解析方式（以当前项目 Supabase/Postgres 版本文档为准）

客户端连接 **开发/测试/生产** 时应使用对应环境的 **Anon Key + URL**；若多环境共库，还需保证 JWT 中 `env` 与建连意图一致。

**JWT 中如何出现 `app_metadata.env`（及可选的 `tier` / `app_id`）**

- 默认签发流程**不会**自动把业务字段写入 JWT；须在 **Auth 侧**显式注入，例如 Supabase 的 **Custom Access Token Hook**（或同版本文档中的等价钩子），在 token 签发/刷新时读取库内事实后写入 **`app_metadata`**（`env`、`tier`、当前 `app_id` 等）。
- 多应用同会话：若同一用户需在短时间在多个 `app_id` 上下文切换，应在**换端/换应用**时刷新会话或通过单独入口签发**仅绑定该应用**的声明，避免 RLS 依赖的 `env`/`app_id` 与连接意图不一致。
- 文档中凡使用 `auth.jwt()->'app_metadata'->>...` 的策略，均以「上述钩子或服务端已同步 `auth.users.app_metadata`」为前提；否则应 **拒绝**（缺少 `env` 等）或改为不依赖 JWT 的路径（不推荐双轨混用）。

### RLS 隔离规则（应用 + 环境）

在原有「应用 + 用户」条件上，**所有相关策略增加环境匹配**：

- 行级条件：`table.env = <从 JWT 解析出的 env>`
- 若某角色允许跨行读应用内数据，仍必须：`table.app_id` 在授权范围内 **且** `table.env` 与会话环境一致

示例（思路，伪代码）：

```sql
-- USING 中同时约束 app 与环境
table.app_id = ...
AND (auth.jwt()->'app_metadata'->>'env') IS NOT NULL
AND (auth.jwt()->'app_metadata'->>'env') IN ('dev', 'test', 'prod')
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
- `user_id` (uuid, fk -> auth.users.id, `ON DELETE RESTRICT`) — Supabase Auth 用户标识；**禁止级联删除**，防止误删 Auth 用户时连带删除应用资料
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
- `user_id` (uuid, fk -> auth.users.id, `ON DELETE RESTRICT`) — **禁止级联删除**
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

### 用户注册与应用加入流程

文档定义了表结构，但**未说明用户如何"进入"某个应用**。当用户首次打开应用 B 时，`app_users` 和 `user_profiles` 的记录由谁创建？

**推荐方案**：通过 Edge Function `join_app(app_id, env)` 在事务内统一初始化：

```sql
-- 伪代码
BEGIN;
  -- 1. 创建应用成员关系（若已存在则跳过或更新）
  INSERT INTO app_users (app_id, user_id, env, user_tier, app_user_status)
  VALUES (p_app_id, p_user_id, p_env, 'basic', 'active')
  ON CONFLICT (app_id, user_id, env) DO NOTHING;

  -- 2. 初始化用户资料（完全独立方案下按应用隔离）
  INSERT INTO user_profiles (app_id, env, user_id, display_name)
  VALUES (p_app_id, p_env, p_user_id, p_display_name)
  ON CONFLICT (app_id, env, user_id) DO NOTHING;

  -- 3. 可选：预开户（若应用需要钱包）
  INSERT INTO wallet_accounts (app_id, user_id, env, currency, available_balance)
  VALUES
    (p_app_id, p_user_id, p_env, 'points', 0),
    (p_app_id, p_user_id, p_env, 'CNY', 0)
  ON CONFLICT (app_id, user_id, currency, env) DO NOTHING;
COMMIT;
```

> **关键点**：
> - `ON CONFLICT DO NOTHING` 保证幂等，用户重复调用不会报错
> - 若 `app_users` 记录不存在，RLS 会拒绝该应用的所有访问，因此必须在用户首次交互前完成初始化
> - 初始化应在 **Edge Function** 中完成，避免客户端直接写入

## 财务管理模块

### 核心表

`wallet_accounts`

- `id` (uuid, pk)
- `app_id` (uuid, fk -> apps.id, `ON DELETE CASCADE`)
- `user_id` (uuid, fk -> auth.users.id, `ON DELETE RESTRICT`) — **禁止级联删除**
- `env` (text) — `dev`/`test`/`prod`，`CHECK (env IN ('dev','test','prod'))`
- `currency` (text) — `CNY` | `USD` | `points`，建议 `CHECK (currency IN ('CNY','USD','points'))`
- `available_balance` (numeric(18,2)) — **必须 >= 0**，建议 `CHECK (available_balance >= 0)`
- `frozen_balance` (numeric(18,2)) — **必须 >= 0**，建议 `CHECK (frozen_balance >= 0)`。冻结金额代表已被业务锁定但尚未实际扣减的余额（如提现审核中、订单预占）。扣款时应校验 `available_balance - frozen_balance >= 扣款金额`
- `updated_at` (timestamptz)
- unique(`app_id`, `user_id`, `currency`, `env`)

`wallet_transactions`

- `id` (uuid, pk)
- `app_id` (uuid, fk -> apps.id, `ON DELETE CASCADE`)
- `env` (text) — `dev`/`test`/`prod`，`CHECK (env IN ('dev','test','prod'))`
- `user_id` (uuid, fk -> auth.users.id, `ON DELETE RESTRICT`) — **禁止级联删除**
- `account_id` (uuid, fk -> wallet_accounts.id, `ON DELETE CASCADE`)
- `biz_type` (text) — `recharge` | `consume` | `refund` | `settle` | `withdraw` | `freeze` | `unfreeze`，建议 `CHECK (...)`
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
-- 示例：扣款函数（事务安全）
CREATE OR REPLACE FUNCTION deduct_balance(
  p_account_id uuid,
  p_amount numeric(18,2),
  p_biz_no text
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_app_id uuid;
  v_env text;
  v_user_id uuid;
BEGIN
  -- 0. 幂等检查：同一业务单号已存在成功流水则直接返回
  IF EXISTS (
    SELECT 1 FROM wallet_transactions wt
    WHERE wt.account_id = p_account_id
      AND wt.biz_no = p_biz_no
      AND wt.status = 'success'
  ) THEN
    RETURN true;
  END IF;

  -- 1. 加锁读取并校验余额（含冻结金额）
  SELECT app_id, env, user_id, available_balance, frozen_balance
  INTO v_app_id, v_env, v_user_id
  FROM wallet_accounts
  WHERE id = p_account_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'wallet account not found';
  END IF;

  -- 调用方校验：service_role / Edge 调用时 auth.uid() 多为 null，可跳过；
  -- 若对 authenticated 开放 EXECUTE，则必须校验账户归属（见下文「SECURITY DEFINER 与 EXECUTE」）
  IF auth.uid() IS NOT NULL AND v_user_id <> auth.uid() THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  
  -- 2. 原子扣减（若可用余额扣除冻结后不足则返回 0 行）
  UPDATE wallet_accounts
  SET available_balance = available_balance - p_amount,
      updated_at = now()
  WHERE id = p_account_id
    AND available_balance - frozen_balance >= p_amount;
    
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
  
EXCEPTION WHEN OTHERS THEN
  -- 任何异常（如流水写入失败）触发整体回滚，余额不会实际扣减
  RAISE;
END;
$$;
```

> **事务安全说明**：上述函数在单一事务内执行。若第 3 步（写流水）因任何原因失败，第 2 步（扣余额）会自动回滚，避免**余额已扣但无流水**的不一致状态。外部调用者应始终通过 `BEGIN ... COMMIT` 包裹此函数调用。

> **SECURITY DEFINER 与 EXECUTE**：`SECURITY DEFINER` 函数以定义者权限执行，**禁止**默认对 `PUBLIC`/`authenticated` 随意开放 `EXECUTE`。推荐：`REVOKE ALL ON FUNCTION deduct_balance(...) FROM PUBLIC;`，仅 `GRANT EXECUTE` 给 **`service_role`**（由 Edge Function 调用），或由仅具高权限角色的后台用户执行。若业务上必须由终端用户直连调用，则函数内须强制 `auth.uid()` 与账户 `user_id` 一致（如上），并仍需最小化授予对象。
>
> **`biz_no` 与 INSERT 幂等**：`unique(app_id, env, biz_no)` 下，**重复请求**会因唯一约束报错。幂等语义应在函数内 **先按 `app_id, env, biz_no` 查询 `wallet_transactions`**：若已有 `success` 流水则直接返回成功（不再动余额）；或与 `INSERT ... ON CONFLICT DO NOTHING` + 回填结果配合。原则是「同一业务单号多次提交**不发生重复扣款/入账**」，与「禁止伪造新单号重复刷」并行。

**方案 B：应用层乐观锁**

`wallet_accounts` 增加 `version` (int) 字段，更新时 `WHERE version = old_version`。

> **原则**：所有财务写操作（扣款、退款、冻结）**禁止**由客户端直接 `UPDATE` 余额表，必须通过上述受控函数/事务完成。

### 冻结与解冻业务流程

`frozen_balance` 用于业务预占场景（如订单未支付、提现审核中）：

1. **冻结**：通过受控函数 `freeze_balance(account_id, amount, biz_no)` 将 `available_balance` 扣减并累加到 `frozen_balance`，写入 `direction = 'out'`、`biz_type = 'freeze'` 的流水。
2. **解冻**：通过 `unfreeze_balance(account_id, amount, biz_no)` 将 `frozen_balance` 扣减并累加回 `available_balance`，写入 `direction = 'in'`、`biz_type = 'unfreeze'` 的流水。
3. **确认扣款**：业务完成后从 `frozen_balance` 中实际扣除（不再回写 `available_balance`），或解冻后走正常 `deduct_balance`。

> 所有冻结/解冻/扣款操作必须在同一事务内完成，且均通过 `SECURITY DEFINER` 函数执行，禁止客户端直接修改余额字段。

### 建议

- 账务只追加流水，不直接改历史记录
- 余额变更通过数据库函数或事务统一处理
- `biz_no`：**业务侧**单号全局唯一（`app_id+env+biz_no`）；库内靠唯一约束防重。**接口幂等**需在函数/Edge 层实现「已存在成功流水则短路返回」，避免客户端重试时收到唯一约束错误却状态不明
- 对账任务建议通过 Edge Functions + Cron 触发
- **points（积分）精度**：`wallet_accounts.available_balance numeric(18,2)` 对积分类型保留两位小数，但积分通常为整数。建议通过 CHECK 约束保证积分无小数位：

  ```sql
  -- 方案 A：按货币精度校验
  ALTER TABLE wallet_accounts ADD CONSTRAINT chk_points_integer
    CHECK (
      (currency = 'points' AND available_balance = floor(available_balance))
      OR currency IN ('CNY', 'USD')
    );
  ```

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
- （可选）`billing_model` (text) — `individual` | `team_seats`，建议 `CHECK (billing_model IN ('individual','team_seats'))`；`team_seats` 表示按 **席位池** 售卖给团队 / 组织（见下文「团队席位制 VIP」）；默认可与个人套餐混存在同一 `vip_plans` 表中
- `status` (text) — `active` | `inactive`，`CHECK (status IN ('active','inactive'))`

> `vip_plans` 通常作为配置表，**不建议**物理删除已创建套餐（避免已售记录悬空）。如需停用，标记 `status = 'inactive'`。

`user_vips`

- `id` (uuid, pk)
- `app_id` (uuid, fk -> apps.id, `ON DELETE CASCADE`)
- `env` (text) — `dev`/`test`/`prod`，`CHECK (env IN ('dev','test','prod'))`
- `user_id` (uuid, fk -> auth.users.id, `ON DELETE RESTRICT`) — **禁止级联删除**
- `plan_id` (uuid, fk -> vip_plans.id, `ON DELETE RESTRICT`) — 已关联销售的套餐不允许删除
- `start_at` (timestamptz)
- `end_at` (timestamptz)
- `status` (text) — `active` | `expired` | `cancelled`，`CHECK (status IN ('active','expired','cancelled'))`
- `source` (text) — `purchase` | `admin_grant` | `activity`，`CHECK (source IN ('purchase','admin_grant','activity'))`

### 功能点

- VIP 开通、续费、过期
- 按应用隔离 VIP 体系
- 权益配置可通过 `benefits` 动态扩展

### 团队 / 组织席位制 VIP

面向「组织统一付费、限制并发成员数（席位）」的套餐：**售卖单元**是「某团队在订阅期内可用的席位上限」，成员只有通过 **席位分配** 才享有团队档权益；与个人 `user_vips`（按人一条开通记录）并行存在。

#### 概念关系

| 对象 | 作用 |
|------|------|
| `teams` | 组织载体（已有约定：`app_id`、`env`） |
| `vip_plans`（`billing_model = 'team_seats'`） | 定价与权益模板（含可选默认席位参考，最终以订阅为准） |
| `team_vip_subscriptions` | **成交实体**：某团队购买了哪个套餐、共多少个席位、起止时间与支付幂等 |
| `team_vip_seat_assignments` | **席位占用**：哪个用户占用一席（有效期内计入席位计数） |
| `app_users.user_tier` / `tier_expires_at` | 被分配席位的成员同步为 **`team`**，到期时间与订阅对齐，便于沿用现有 RLS「有效档位」表达式 |

不要求每个占席用户再写一行 `user_vips`（可选镜像写入便于报表，但 **授权仍以「订阅有效 + 席位分配有效」为准**，避免双源不一致）。

#### 核心表（建议在 migrations 中落地）

`team_vip_subscriptions`

- `id` (uuid, pk)
- `app_id` (uuid, fk -> apps.id, `ON DELETE CASCADE`)
- `env` (text) — `CHECK (env IN ('dev','test','prod'))`
- `team_id` (uuid, fk -> teams.id, `ON DELETE CASCADE` 或 `RESTRICT`，按是否在解散团队时保留订阅审计选择)
- `plan_id` (uuid, fk -> vip_plans.id, `ON DELETE RESTRICT`)
- `seat_limit` (int) — **席位上限**，`CHECK (seat_limit > 0)`
- `start_at` / `end_at` (timestamptz) — 订阅生效区间；可与 `vip_plans.duration_days` 在开通时换算写入
- `status` (text) — `active` | `expired` | `cancelled`，`CHECK (...)`
- `biz_no` (text, nullable) — 支付 / 签约幂等键；建议 **`unique(app_id, env, biz_no)`**（与钱包等业务单号体系一致时可共用前缀区分）
- `metadata` (jsonb, default '{}')
- `created_at` (timestamptz)

`team_vip_seat_assignments`

- `id` (uuid, pk)
- `app_id` (uuid, fk -> apps.id, `ON DELETE CASCADE`)
- `env` (text) — `CHECK (env IN ('dev','test','prod'))`
- `subscription_id` (uuid, fk -> team_vip_subscriptions.id, `ON DELETE CASCADE`)
- `user_id` (uuid, fk -> auth.users.id, `ON DELETE RESTRICT`) — **禁止级联删除**
- `status` (text) — `active` | `revoked`，`CHECK (status IN ('active','revoked'))`
- `assigned_at` (timestamptz)
- `revoked_at` (timestamptz, nullable)
- `assigned_by_user_id` (uuid, nullable) — 管理员或团队管理员
- `created_at` (timestamptz)

```sql
-- 同一订阅下同一人仅一条有效占席
CREATE UNIQUE INDEX idx_team_vip_seats_unique_active
  ON team_vip_seat_assignments(subscription_id, user_id)
  WHERE status = 'active';
```

**约束与计数**

- **占席总数不超过 `seat_limit`**：须在 **`SECURITY DEFINER` 函数或 Edge Function** 内 `SELECT ... FOR UPDATE` 锁定 `team_vip_subscriptions` 行后，统计 `status = 'active'` 条数再允许插入 / 激活；禁止仅靠客户端校验。
- 订阅 `status != 'active'` 或 `now()` 不在 `[start_at, end_at]` 内时，不得新增有效占席；已有占席应按规则 **撤销或批量降级**（见下）。

#### 与 `app_users` 同步（推荐）

席位 **生效**（`assignment.status = 'active'` 且订阅有效）时，在同一事务内更新对应用户在 `(app_id, env)` 下的：

- `user_tier = 'team'`
- `tier_expires_at = subscription.end_at`（或团队单独策略；若允许多段订阅叠加需另行定义优先级）

席位 **撤销** 或 **订阅到期 / 解约**：

- 将该用户在该 `(app_id, env)` 下 **不再存在任何有效团队席位** 时，`user_tier` 降为 `basic`，`tier_expires_at` 清空（或与仍有效的个人 `paid` VIP 对齐，由业务规则决定优先级）。
- 所有批量变更写入 **`user_tier_change_logs`**，`reason` 可使用 `team_seat_revoke`、`team_subscription_expire` 等扩展枚举。

定时任务除扫描 `app_users.tier_expires_at` 外，应扫描 **`team_vip_subscriptions.end_at`**，批量失效订阅并触发占席清理与档位同步。

#### RLS 要点

- `team_vip_subscriptions`：**团队管理员或具备财务/VIP 权限的运营角色**可读写在对应 `app_id` + `env`；普通成员通常仅可读与本团队相关的摘要（按需裁剪列）。
- `team_vip_seat_assignments`：成员可读 **与自己有关** 的行；管理员可读团队内分配列表。
- **团队资源表**（带 `team_id`）：策略仍为「团队成员 **且**（个人有效 `team` 档 **或** 占席有效 —— 二者若等价同步到 `app_users` 则可继续仅用 `effective_user_tier` / `exists app_users`）」；避免仅信任 JWT。

索引（`team_vip_*`）见上文 **「索引与性能设计」** 中与 VIP 并列的段落；启用席位模块时在 migrations 中一并创建。

#### 服务端职责（Edge Functions）

- 开通 / 续费 / 解约团队订阅（支付回调幂等、`biz_no`）
- **分配席位 / 撤销席位**（强制席位上限与订阅窗口校验）
- 订阅到期批量撤销占席并刷新 `app_users`
- **档位合成**：与个人 `paid` / `user_vips` 叠加时执行下文「`paid` 与 `team` 并存」规则；所有写入 `app_users` 的路径收口到少量 Edge / DB 函数，避免分叉逻辑

#### 团队解散与 `teams` 外键策略

| `team_vip_subscriptions.team_id` → `teams.id` | 适用场景 |
|-----------------------------------------------|---------|
| **`ON DELETE RESTRICT`（推荐默认）** | 存在任意 **未归档** 订阅（尤其 `status = 'active'`）时 **禁止删除团队**，必须先解约、作废订阅或整体退款流程结束；利于财务审计不断档 |
| **`ON DELETE CASCADE`** | 团队物理删除即带走订阅与占席；实现简单但 **订阅与回款审计链断裂**，仅适合强确信「团队即租户」且无合规留存 |
| **团队仅软删**（`teams.status = 'deleted'` + RLS 禁止新业务） | 与 RESTRICT 组合最佳：业务上「解散」不删主键行，订阅自然到期或与法务流程对齐后再归档 |

**占席侧**：`subscription_id` → `team_vip_subscriptions` 常用 **`ON DELETE CASCADE`**（删除订阅则分配一并清理）；若需永久保留分配历史审计，可改为 `ON DELETE RESTRICT`，仅以订阅 **`status`** 作废而非物理删除订阅行。

#### `paid` 个人 VIP 与 `team` 席位并存（推荐默认）

`app_users.user_tier` 为 **单一枚举**，建议在 Edge / `SECURITY DEFINER` **统一合成函数**内按下表刷新（任意订阅变更、VIP 变更、撤销席位后调用）：

| 有效来源（同一 `app_id` + `env`） | `user_tier` | `tier_expires_at` |
|----------------------------------|-------------|-------------------|
| 仅有有效团队占席 + 订阅窗口内 | `team` | 对应 **`team_vip_subscriptions.end_at`**（多订阅并存时取 **最远 `end_at`** 或拒绝重叠，见下） |
| 无团队占席，但有有效个人 `user_vips`（`paid` 语义） | `paid` | 个人 VIP **`end_at`**（多条取最远或与业务约定一致） |
| 两者皆无 | `basic` | `NULL` |
| **两者兼有（默认产品策略）** | **`team`** | **`team` 订阅的 `end_at`**（协作档优先）；个人付费独享能力仍可通过 **`user_vips` / `benefits`** 在 **RLS 或单独布尔/配额字段** 中叠加判断，避免单靠 `user_tier` 表达交集 |

若产品要求「个人付费权益始终覆盖团队包装」，可改为 **`paid` 优先**，但须在全文与前台文案中固定一种顺序，**禁止**客户端本地推断。**写回 `app_users` 的实现须集中在 `recompute_app_user_tier`**（见「数据库基础设施函数」），并在该函数内调换 `team` / `paid` 分支顺序与文档保持一致。

**同一用户多条 active 团队订阅**：须在业务层约束「同一 `(user_id, app_id, env)` 最多一条 active `team_vip_seat_assignments`」，或允许多条但 **`tier_expires_at = max(相关订阅.end_at)`** 并由定时任务与 RLS 一致收敛。

#### 席位分配原子流程（提纲）

单席位分配须在 **同一事务** 内完成：

1. `SELECT ... FROM team_vip_subscriptions WHERE id = $1 FOR UPDATE`
2. 校验 `status = 'active'` 且 `now()` ∈ `[start_at, end_at]`（边界语义产品自定）
3. `SELECT COUNT(*) FROM team_vip_seat_assignments WHERE subscription_id = $1 AND status = 'active'`（可加 `FOR UPDATE` 依赖父行锁序列化）
4. 若 `count >= seat_limit` → 拒绝；否则 `INSERT` 分配（或 revive）并调用 **`recompute_app_user_tier(app_id, env, user_id, ...)`**（见「数据库基础设施函数」）
5. 写入审计（`user_tier_change_logs` 可由合成函数一并写入）

重复提交同一 `(subscription_id, user_id)`：依赖 **部分唯一索引** 或由 Edge **幂等键**（如 `assignment_client_token`）短路。

#### 迁移脚本命名（通用模块）

团队席位相关 DDL 属于**跨应用公共模块**，建议文件名与设计文档一致，不做 `ext_schema_prefix` 前缀：

- 示例：`YYYYMMDDHHMM_team_vip_subscriptions.sql`、`YYYYMMDDHHMM_team_vip_seat_assignments.sql`
- `teams` / `team_memberships` 若与本模块同批次引入，可使用 `YYYYMMDDHHMM_teams_core.sql`

## 用户级别（基础 / 付费 / 团队会员）

面向终端用户的产品档位，用于区分默认能力、配额与部分资源的可见/可写范围；与 **VIP 套餐**（`vip_plans`、个人 `user_vips`、以及可选 **团队席位制** `team_vip_subscriptions` / `team_vip_seat_assignments`）可关联：`user_tier` 可由当前有效 VIP、有效团队席位、订阅状态或运营策略计算得出。

### 档位语义（建议）

| 档位 | 代码 | 典型能力 |
|------|------|----------|
| 基础 | `basic` | 默认免费能力；资源/功能受限 |
| 付费 | `paid` | 个人付费后的增强能力（存储、导出、高级功能等） |
| 团队会员 | `team` | 组织/协作维度：共享空间、成员席位、团队级资源与审计 |

### 存储位置

- **权威数据源（推荐）**：`app_users.user_tier`（已含 `app_id` + `env`），支付确认、套餐变更、团队绑定等事务内更新；复杂场景由 **`recompute_app_user_tier`** 统一写回（见「数据库基础设施函数」）。RLS 策略通过 **JOIN `app_users` 或 `exists` 子查询** 读取当前用户的档位，避免仅凭 JWT 盲信。
- **JWT 自定义声明（加速路径）**：将档位镜像到 **`app_metadata`**（例如 `app_metadata.tier` 或与 `app_id`/`env` 组合的嵌套结构），便于策略中快速判断。**不得**使用 `user_metadata` 作为授权依据（用户可自改）。
  注意：JWT 可能滞后于数据库（例如刚付款未刷新 token），敏感操作仍应以 **库表为准** 或在业务层强制刷新会话。
- **复杂场景**：团队席位制 VIP（`team_vip_subscriptions` / `team_vip_seat_assignments`）、团队基础模型 **团队表 + 成员表**（见「团队数据模型与级联」），RLS 用 `exists` 关联团队与资源上的 `team_id`。
- **到期降级**：`tier_expires_at` 到期后，应通过 **`recompute_app_user_tier`** 重新计算权威档位（而非直接设为 `basic`，因为用户可能仍有有效的个人 `paid` VIP）；**授权判定**优先在 RLS/函数中使用「当前时间相对 `tier_expires_at`」的有效档位表达式，避免仅读 `user_tier` 字段而忽略过期。

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
       AND au.app_user_status = 'active'
       AND (
         au.user_tier = 'basic'
         OR (
           au.user_tier IN ('paid','team')
           AND (au.tier_expires_at IS NULL OR au.tier_expires_at > now())
         )
       )
   )
   ```

   `banned` / `deleted` 成员应被上述条件排除；若策略未带 `app_user_status`，封禁或软删用户仍可能满足其他谓词造成越权，**须统一约束**。

2. **定时补偿修正（第二道防线）**
   使用 **pg_cron**（Supabase 支持）或 **Edge Function + Cron Trigger**，定期扫描过期记录并修正：

    ```sql
    -- pg_cron 示例：每 5 分钟扫描并降级（兜底方案，最简产品可用）
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
    ⚠️ **注意**：上述纯 `UPDATE basic` 有缺陷——用户可能团队订阅过期但仍持有有效的个人 `paid` VIP，此时直接降级会丢失个人付费权益。**推荐做法**：Cron / Edge 列出「`tier_expires_at` 已过但仍可能叠加 VIP」的 `user_id`，对每个调用 **`recompute_app_user_tier(app_id, env, user_id, 'cron_tier_fix')`**；仅在确认无席位模块且无个人 VIP 的最简产品中保留纯 `UPDATE basic`。

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
   SET search_path = public
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
       AND au.user_id = p_user_id
       AND au.app_user_status = 'active';
   $$;
   ```

   与上文「数据库基础设施函数」中的 `effective_user_tier` 定义须**保持一致**（含 `SET search_path`、是否排除非 `active` 成员）；以 migrations 中单一源为准。

### 与 RLS 的配合方式（核心）

权限控制的 **强制执行点** 在 Postgres RLS；可选两种建模组合（可同时使用）：

1. **独立权限表 / 档位字段（权威）**
   - 策略中：`exists (... app_users ... user_tier in ('paid','team'))`
   - 或资源表带 `required_tier`，策略：`app_users.user_tier` 满足 `>= 所需档位`（需定义档位序或映射表）。

2. **自定义 Claims（Mirror）**
   - 策略中：`coalesce((auth.jwt()->'app_metadata'->>'tier'), '')` 与库表一致时使用；或 **仅以 claims 做第一层过滤，最终以 `app_users` 校验防篡改**。
   - 支付/升降级后：更新 `app_users.user_tier`，并通过 Admin API 更新 `app_metadata`，促使用户下次 JWT 携带新档位。

管理员（RBAC）绕开终端档位限制时，仍须满足 **`user_roles` +（推荐）`permissions`** + **`app_id` + `env`**，避免与普通用户策略混淆。

### 团队数据模型与级联（删除团队时清理成员）

- `teams`：`id`, `app_id`, `env`, …
- `team_memberships`：`team_id` → `teams(id)` **`ON DELETE CASCADE`**，`user_id`, `role_in_team`, …

删除团队行时，数据库自动删除所有成员关联，避免悬空成员仍通过旧 `team_id` 访问资源；RLS 仍应绑定「成员存在且团队未删除」。若已启用 **团队席位制 VIP**，`team_vip_subscriptions` 与 `teams` 的外键及「解散 / 删团队」顺序见上文 VIP 小节 **「团队解散与 `teams` 外键策略」**。

### 档位变更审计（纠纷与合规）

`user_tier_change_logs`（或等价命名）

- `id`, `app_id`, `env`, `user_id`
- `old_tier`, `new_tier`
- `old_expires_at`, `new_expires_at`（可选，便于核对订阅周期）
- `reason` (text) — `purchase_expire` | `admin_adjust` | `refund` | `team_dissolve` | `team_seat_revoke` | `team_subscription_expire` 等
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

5. **`auth.users` 删除策略**
   本文档中所有指向 `auth.users.id` 的外键均使用 `ON DELETE RESTRICT`（包括 `app_users`、`user_profiles`、`wallet_accounts`、`wallet_transactions`、`user_vips`、`team_vip_seat_assignments`、`user_roles`、`app_user_metadata` 等）。

   **原因**：多应用平台中，Auth 用户是跨应用的认证凭据。若使用 `ON DELETE CASCADE`，在 Supabase Auth 中删除一个用户将级联删除该用户在**所有应用**的全部数据，造成不可逆的数据丢失。

   **用户注销流程**（必须通过 Edge Function 执行）：
   1. 在各应用下标记 `app_user_status = 'deleted'`（软删除）
   2. 7 天后由后台任务清理各应用内的敏感数据（钱包流水保留脱敏审计）
   3. 确认无未完结财务/订阅纠纷后，最后才删除 `auth.users`
   4. 若尝试直接删除 `auth.users` 仍存在关联数据，数据库会因 `RESTRICT` 约束拒绝，强制走上述流程

## 权限管理（RBAC）

### RLS + Claims + 权限表：分工（终端用户 vs 运营）

| 维度 | 终端用户（产品档位） | 运营 / 后台（RBAC） |
|------|----------------------|---------------------|
| 目的 | 基础/付费/团队能访问的功能与数据 | 谁能管理用户、财务、VIP、配置 |
| 权威数据 | `app_users.user_tier` + 业务表 | `user_roles`、`roles`、`permissions` |
| JWT | 可选：`app_metadata` 镜像档位、环境 | 可选：`app_metadata` 中的管理员标记 **仅作提示**，RLS 仍以表为准 |
| RLS | `tier` + `app_id` + `env` + 资源条件 | `exists(user_roles → permissions...)` + 同上租户隔离 |

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
- `user_id` (uuid, fk -> auth.users.id, `ON DELETE RESTRICT`) — **禁止级联删除**
- `role_id` (uuid, fk -> roles.id, `ON DELETE CASCADE`)
- unique(`app_id`, `user_id`, `role_id`, `env`)

### 权限校验策略

- 前端：按权限码与 **用户级别** 控制菜单/按钮显示（展示层不能替代 RLS）
- 后端：Edge Functions 或 SQL 函数内强制校验权限与档位
- 数据层：**RLS 为核心** — 按 `app_id` + **`env`** + **用户级别（`app_users.user_tier`）** + **RBAC（管理员）** + 资源归属联合判定

### 管理员 RLS 与 permissions（推荐）

前文模板中「仅 `EXISTS user_roles + roles`」便于理解与原型验证；**生产环境**应将管理员策略 **关联到 `permissions.code`**（或等价能力模型），避免任意被授予角色的账号访问财务、封禁等高危操作：

```sql
-- 示例：当前用户对目标行所属 app/env 拥有权限码 user.read（按需替换 code）
EXISTS (
  SELECT 1
  FROM user_roles ur
  JOIN role_permissions rp ON rp.role_id = ur.role_id
  JOIN permissions perm ON perm.id = rp.permission_id
  WHERE ur.user_id = auth.uid()
    AND ur.app_id = <table>.app_id
    AND ur.env = <table>.env
    AND perm.code = 'user.read'
)
```

可对 **`roles.code = 'super_admin'`** 等保留短路分支（仍需写入审计）；若团队倾向集中管控，也可让**全部管理写路径**仅通过 **Edge Function + service_role**，Edge 内校验运营 JWT 与权限表后再写入，数据库侧对 `authenticated` **不开放**管理员类策略——二者择一或组合，须在评审中固化。

### 灵活策略示例（思路）

- **按档位可读**：仅「有效」`paid`/`team` 可读 —— `exists (... app_users au ... au.app_user_status = 'active' and <有效档位条件含 tier_expires_at>)`，勿省略过期判断
- **团队资源**：行带 `team_id`，策略要求 `exists (team_memberships where user_id = auth.uid() and team_id = row.team_id)` 且档位为 `team`
- **Claims 辅助**：`auth.jwt()->'app_metadata'->>'tier' = 'paid'` **且** `exists (app_users ... user_tier = 'paid' and app_user_status = 'active')`，双因子防止 JWT 与库不一致时的越权

## RLS 安全设计（关键）

所有暴露给客户端访问的业务表默认开启 RLS，并至少遵循：

1. **会话环境匹配**：行数据的 `env` 必须与 JWT（推荐 `app_metadata.env`）一致；缺失或非法 `env` 一律拒绝
2. 终端用户须在 `app_users` 上具备 **`app_user_status = 'active'`** 的成员关系（`app_id` + `env`）；`banned` / `deleted` 默认拒绝访问业务数据（管理员路径除外）
3. **用户级别**：受档位控制的资源，必须以库内 **`app_users` 的有效档位**（含 **`tier_expires_at` 与当前时间比较**）及必要的团队/订阅表为满足条件；**不信任前端 tier**；自定义 claims 仅作辅助，且 **不以 `user_metadata` 为授权依据**
4. 普通用户只能访问**自己所属应用**下的用户资料、钱包、VIP 数据（`app_id` 与 `env` 均须一致）；团队场景扩展为「本人或本团队成员」
5. 管理员路径：`user_roles` + **`role_permissions` → `permissions.code`**（或与 Edge/service_role 路径二选一）；仍须 **`app_id` + `env`** 与 JWT 一致
6. 财务相关写操作必须通过受控函数执行

示例（思路）：

```sql
-- 基础策略：env 非空且合法 + 应用成员关系 + 资源归属
USING (
  (auth.jwt()->'app_metadata'->>'env') IS NOT NULL
  AND (auth.jwt()->'app_metadata'->>'env') IN ('dev', 'test', 'prod')
  AND <table>.env = (auth.jwt()->'app_metadata'->>'env')
  AND EXISTS (
    SELECT 1 FROM app_users au
    WHERE au.app_id = <table>.app_id
      AND au.env = <table>.env
      AND au.user_id = auth.uid()
      AND au.app_user_status = 'active'
  )
  AND <table>.user_id = auth.uid()
)
```
- 需要档位时：在上述 `exists` 中增加有效档位谓词（**含 `tier_expires_at`**），或与独立 `tier_requirements` 映射表关联；可选封装 `security definer` 函数 `effective_user_tier(app_id, env, uid)`（仅统计 **`active`** 成员；非 active 返回 NULL）供策略复用（函数置于私有 schema，内部仍只读表）

### Realtime 订阅安全

Supabase Realtime 的 `postgres_changes` 监听与 Postgres RLS **是两套独立机制**。在启用 Realtime 推送时，必须额外约束订阅范围：

- **客户端订阅**须在服务端允许的过滤维度内**尽量收窄**：至少 `user_id=eq.${auth.uid()}`；若 **单库多 `env`** 且 Realtime filter 支持组合条件，应叠加 **`env=eq.${sessionEnv}`**（列须存在）；禁止依赖「仅靠客户端筛选」的全表或大粒度 topic。
- **`postgres_changes` filter** 语法因 SDK/版本而异；无法组合过滤时，**必须以 RLS** 收紧可见行（见下），且 UI 侧仍应避免订阅过宽。

  ```javascript
  // 示例：至少按用户收窄（若能过滤 env，请追加 env=eq....）
  supabase.channel('wallet')
    .on('postgres_changes', {
      event: 'INSERT',
      schema: 'public',
      table: 'wallet_transactions',
      filter: `user_id=eq.${currentUserId}`
    }, callback)
    .subscribe();
  ```

- **RLS 补充**：即使 Realtime 侧过滤正确，Postgres 侧的 RLS 仍必须生效（Realtime 会使用 RLS 做行级过滤）。确保 `wallet_transactions` 等表的 RLS `SELECT` 策略已限制 `user_id = auth.uid()` **且 `env` 与会话一致**（单库多环境时尤为关键）。
- **避免敏感字段泄露**：Realtime 推送会携带整行数据。以下表**强烈建议禁用 Realtime**或建立字段级过滤机制：
  - `wallet_transactions`：可能包含支付渠道原始回调数据、商户密钥片段
  - `app_configs`（`is_sensitive = true` 的行）：含密钥等敏感配置
  - `user_profiles`：若含手机号、身份证号等 PII
  - 禁用方式：`ALTER TABLE wallet_transactions REPLICA IDENTITY DEFAULT;` 或应用层不订阅敏感表

  > 若业务确实需要 Realtime 推送敏感表的变更，应通过 Edge Function 作为中转，由服务端过滤敏感字段后再推送至客户端。

### RLS 策略测试规范

RLS 策略的错误配置可能导致数据泄露或越权访问，必须在上线前通过自动化测试验证。

**测试方法**：

```sql
-- 测试示例：模拟用户 A 查询 wallet_transactions
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{
  "sub": "user-a-uuid",
  "app_metadata": {"env": "prod"}
}'::jsonb;

-- 预期：只能看到 user-a 自己的流水
SELECT count(*) FROM wallet_transactions WHERE user_id = 'user-a-uuid';
-- 预期：看不到 user-b 的流水
SELECT count(*) FROM wallet_transactions WHERE user_id = 'user-b-uuid'; -- 应返回 0

-- 测试管理员角色
SET LOCAL request.jwt.claims = '{
  "sub": "admin-uuid",
  "app_metadata": {"env": "prod"}
}'::jsonb;
-- 预期：管理员可以看到同一应用、同一环境的所有数据
SELECT count(*) FROM wallet_transactions WHERE app_id = 'app-uuid';
```

**测试覆盖要求**：

| 角色 | 测试目标 | 预期结果 |
|------|---------|---------|
| 普通用户 | 查询自己的数据 | 返回数据 |
| 普通用户 | 查询其他用户的数据 | 返回空结果 |
| 普通用户 | 查询其他应用的数据 | 返回空结果 |
| 普通用户 | 查询其他环境的数据 | 返回空结果 |
| 管理员 | 查询应用内所有数据 | 返回数据（需 RBAC 校验） |
| 已封禁用户 | 查询任何数据 | 返回空结果（`app_user_status = 'banned'`） |
| 已软删用户 | 查询终端业务数据 | 返回空结果（`app_user_status = 'deleted'`） |

> 建议在 CI/CD 流程中集成 RLS 测试，每次 migrations 变更后自动运行。

## API 与服务边界建议

- 客户端直连 Supabase：
  - 读取自己的用户资料、VIP 状态、个人账单
- 服务端（Edge Functions）：
  - 支付回调验签
  - 批量结算与对账
  - 管理后台高权限操作（封禁、调账、授予 VIP、**团队席位分配与订阅管理**）

## 管理后台建议菜单

- 应用管理：应用列表、状态管理、应用配置
- 用户管理：用户检索、封禁解禁、资料查看、行为日志
- 财务管理：账户、流水、对账、提现审核
- VIP 管理：套餐、开通记录、续费记录、过期处理；**团队席位**：订阅、席位上限、分配与回收
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

### 数据归档策略

`wallet_transactions`、`user_status_logs`、`user_tier_change_logs` 等流水/审计表会线性增长，需制定归档策略避免存储耗尽。

**推荐方案**：

| 数据热度 | 保留位置 | 保留时长 | 查询方式 |
|---------|---------|---------|---------|
| 热数据 | Postgres 原表 | 90 天 | 直接查询 |
| 温数据 | Supabase Storage（Parquet/CSV） | 1-2 年 | 下载后分析 |
| 冷数据 | 外部数仓（如 ClickHouse/BigQuery） | 永久 | 数仓查询 |

**归档实施**：通过 Edge Function + Cron Trigger 定期（如每月 1 日）将历史数据导出到 Storage，然后从原表删除：

```sql
-- 示例：归档 90 天前的钱包流水
WITH archived AS (
  DELETE FROM wallet_transactions
  WHERE created_at < now() - interval '90 days'
  RETURNING *
)
-- 将 archived 结果写入 Storage（通过 Edge Function）
```

> **注意**：归档脚本必须使用 `service_role` 并在应用层明确指定 `app_id` + `env`，避免误删。归档前应验证数据完整性（行数、金额汇总）。

### Rate Limiting 与防刷

- **支付回调（Edge Functions）**：必须实现幂等校验（`biz_no` 去重）和请求签名验证，防止重放攻击。
- **登录/注册接口**：利用 Supabase Auth 内置的 rate limiting（如邮件验证码频次限制）。
- **自定义 API（Edge Functions）**：对敏感操作（如高频查询、批量导出）增加 IP / 用户级 rate limiting，可使用 Cloudflare Workers 或 Edge Function 内部计数器。

### 连接池与性能注意事项

Supabase 的连接池有限：
- 免费 tier：约 30 个并发连接
- 付费 tier：约 60-150 个（取决于 plan）

多应用共享一个 Supabase 项目时，所有应用共用同一连接池。RLS 策略中的复杂 `EXISTS` 子查询会增加连接占用时间。

**建议**：
- 客户端连接使用 Supabase 的 **connection pooler**（端口 6543），避免直接连接 Postgres（端口 5432）耗尽连接
- 复杂 RLS 策略考虑使用 `SECURITY DEFINER` 函数缓存档位查询结果，减少重复子查询开销
- 监控慢查询，`EXISTS (SELECT 1 FROM app_users ...)` 必须命中索引（`idx_app_users_user_app_env`）
- 后台任务（如归档、对账）应使用独立的 `service_role` 连接，并在完成后立即释放

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
- 团队维度成员表与共享资源的 RLS 策略细化；团队删除级联与资源清理策略复核；**团队席位制 VIP**（订阅、分配、到期同步 `app_users`）
- `tier_expires_at` 到期降级任务（pg_cron / Edge Function Cron）与审计完整性
