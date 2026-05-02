-- ============================================
-- 核心表结构：应用管理、用户体系、财务、VIP、RBAC
-- 适用于: Supabase Postgres 15+
-- ============================================

-- ============================================
-- 1. 应用主表 (apps)
-- ============================================
CREATE TABLE apps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_key text NOT NULL UNIQUE,
  name text NOT NULL,
  platform text NOT NULL CHECK (platform IN ('ios', 'android', 'web', 'desktop')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  metadata jsonb NOT NULL DEFAULT '{}',
  ext_schema_prefix text,
  login_methods text[] NOT NULL DEFAULT '{"email"}',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 检查登录方式
ALTER TABLE apps ADD CONSTRAINT chk_login_methods
  CHECK (login_methods <@ ARRAY['email', 'phone_otp', 'wechat', 'google', 'apple']);

-- 索引
CREATE INDEX idx_apps_status ON apps(status);
CREATE INDEX idx_apps_platform ON apps(platform);

-- 触发器: 更新时间戳
CREATE TRIGGER update_apps_updated_at
  BEFORE UPDATE ON apps
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- RLS
ALTER TABLE apps ENABLE ROW LEVEL SECURITY;

-- 应用数据可被读取（用于列表展示）
CREATE POLICY "apps_read_public"
  ON apps
  FOR SELECT
  USING (status = 'active');

COMMENT ON TABLE apps IS '应用主表，存储所有注册应用的基本信息';

-- ============================================
-- 2. 应用用户绑定表 (app_users)
-- ============================================
CREATE TABLE app_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  env text NOT NULL CHECK (env IN ('dev', 'test', 'prod')),
  user_tier text NOT NULL DEFAULT 'basic' CHECK (user_tier IN ('basic', 'paid', 'team')),
  tier_expires_at timestamptz,
  app_user_status text NOT NULL DEFAULT 'active' CHECK (app_user_status IN ('active', 'banned', 'deleted')),
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(app_id, user_id, env)
);

-- 索引
CREATE INDEX idx_app_users_user_app_env ON app_users(user_id, app_id, env);
CREATE INDEX idx_app_users_tier_expires ON app_users(tier_expires_at)
  WHERE user_tier IN ('paid', 'team') AND tier_expires_at IS NOT NULL;
CREATE INDEX idx_app_users_status ON app_users(app_id, env, app_user_status);

-- 触发器
CREATE TRIGGER update_app_users_updated_at
  BEFORE UPDATE ON app_users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- RLS
ALTER TABLE app_users ENABLE ROW LEVEL SECURITY;

-- 用户只能查看自己的应用成员记录
CREATE POLICY "app_users_self_access"
  ON app_users
  FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

COMMENT ON TABLE app_users IS '应用-用户绑定表，同一用户在不同应用/环境拥有独立记录';

-- ============================================
-- 3. 用户资料表 (user_profiles)
-- ============================================
CREATE TABLE user_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  env text NOT NULL CHECK (env IN ('dev', 'test', 'prod')),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  display_name text,
  avatar_url text,
  phone text,
  country_code text,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(app_id, env, user_id)
);

-- 索引
CREATE INDEX idx_user_profiles_user_app_env ON user_profiles(user_id, app_id, env);

-- 触发器
CREATE TRIGGER update_user_profiles_updated_at
  BEFORE UPDATE ON user_profiles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- RLS
ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "user_profiles_self_access"
  ON user_profiles
  FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

COMMENT ON TABLE user_profiles IS '用户资料表，按应用和环境隔离';

-- ============================================
-- 4. 应用配置表 (app_configs)
-- ============================================
CREATE TABLE app_configs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  env text NOT NULL CHECK (env IN ('dev', 'test', 'prod')),
  config_key text NOT NULL,
  config_value jsonb NOT NULL DEFAULT '{}',
  is_sensitive boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(app_id, env, config_key)
);

-- 索引
CREATE INDEX idx_app_configs_app_env ON app_configs(app_id, env);
CREATE INDEX idx_app_configs_key ON app_configs(config_key);

-- 触发器
CREATE TRIGGER update_app_configs_updated_at
  BEFORE UPDATE ON app_configs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- RLS
ALTER TABLE app_configs ENABLE ROW LEVEL SECURITY;

-- 普通用户只能读取非敏感配置
CREATE POLICY "app_configs_user_read"
  ON app_configs
  FOR SELECT
  USING (
    is_sensitive = false
    AND EXISTS (
      SELECT 1 FROM app_users au
      WHERE au.app_id = app_configs.app_id
        AND au.env = app_configs.env
        AND au.user_id = auth.uid()
        AND au.app_user_status = 'active'
    )
  );

COMMENT ON TABLE app_configs IS '应用配置表，存储应用级结构化配置';

-- ============================================
-- 5. 应用用户元数据表 (app_user_metadata)
-- ============================================
CREATE TABLE app_user_metadata (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  env text NOT NULL CHECK (env IN ('dev', 'test', 'prod')),
  meta_key text NOT NULL,
  meta_value jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(app_id, user_id, env, meta_key)
);

-- 索引
CREATE INDEX idx_app_user_metadata_user_app_env ON app_user_metadata(user_id, app_id, env);
CREATE INDEX idx_app_user_metadata_key ON app_user_metadata(meta_key);

-- 触发器
CREATE TRIGGER update_app_user_metadata_updated_at
  BEFORE UPDATE ON app_user_metadata
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- RLS
ALTER TABLE app_user_metadata ENABLE ROW LEVEL SECURITY;

CREATE POLICY "app_user_metadata_self_access"
  ON app_user_metadata
  FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

COMMENT ON TABLE app_user_metadata IS '应用用户元数据表，EAV 模型存储需索引的用户扩展数据';

-- ============================================
-- 6. 钱包账户表 (wallet_accounts)
-- ============================================
CREATE TABLE wallet_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  env text NOT NULL CHECK (env IN ('dev', 'test', 'prod')),
  currency text NOT NULL CHECK (currency IN ('CNY', 'USD', 'points')),
  available_balance numeric(18, 2) NOT NULL DEFAULT 0 CHECK (available_balance >= 0),
  frozen_balance numeric(18, 2) NOT NULL DEFAULT 0 CHECK (frozen_balance >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(app_id, user_id, currency, env)
);

-- 索引
CREATE INDEX idx_wallet_accounts_user_app_env ON wallet_accounts(user_id, app_id, env);

-- 触发器
CREATE TRIGGER update_wallet_accounts_updated_at
  BEFORE UPDATE ON wallet_accounts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- RLS
ALTER TABLE wallet_accounts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "wallet_accounts_self_access"
  ON wallet_accounts
  FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

COMMENT ON TABLE wallet_accounts IS '钱包账户表，支持多币种';

-- ============================================
-- 7. 钱包流水表 (wallet_transactions)
-- ============================================
CREATE TABLE wallet_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  env text NOT NULL CHECK (env IN ('dev', 'test', 'prod')),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  account_id uuid NOT NULL REFERENCES wallet_accounts(id) ON DELETE CASCADE,
  biz_type text NOT NULL CHECK (biz_type IN ('recharge', 'consume', 'refund', 'settle', 'withdraw', 'freeze', 'unfreeze')),
  amount numeric(18, 2) NOT NULL CHECK (amount > 0),
  direction text NOT NULL CHECK (direction IN ('in', 'out')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'success', 'failed')),
  biz_no text NOT NULL,
  ext jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 索引
CREATE INDEX idx_wallet_transactions_biz_no ON wallet_transactions(app_id, env, biz_no);
CREATE INDEX idx_wallet_transactions_user_created ON wallet_transactions(user_id, created_at DESC);
CREATE INDEX idx_wallet_transactions_account ON wallet_transactions(account_id, created_at DESC);

-- 唯一约束（业务单号幂等）
-- 注意：如果使用 TimescaleDB，需要包含分区键
-- ALTER TABLE wallet_transactions ADD CONSTRAINT uq_wallet_transactions_biz_no
--   UNIQUE(app_id, env, biz_no, created_at);

-- RLS
ALTER TABLE wallet_transactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "wallet_transactions_self_access"
  ON wallet_transactions
  FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

COMMENT ON TABLE wallet_transactions IS '钱包流水表，记录所有资金变动';

-- ============================================
-- 8. VIP 套餐表 (vip_plans)
-- ============================================
CREATE TABLE vip_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  env text NOT NULL CHECK (env IN ('dev', 'test', 'prod')),
  name text NOT NULL,
  level int NOT NULL DEFAULT 1,
  price numeric(18, 2) NOT NULL CHECK (price >= 0),
  duration_days int NOT NULL CHECK (duration_days > 0),
  benefits jsonb NOT NULL DEFAULT '{}',
  billing_model text NOT NULL DEFAULT 'individual' CHECK (billing_model IN ('individual', 'team_seats')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 索引
CREATE INDEX idx_vip_plans_app_env ON vip_plans(app_id, env);
CREATE INDEX idx_vip_plans_status ON vip_plans(app_id, env, status);

-- 触发器
CREATE TRIGGER update_vip_plans_updated_at
  BEFORE UPDATE ON vip_plans
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- RLS
ALTER TABLE vip_plans ENABLE ROW LEVEL SECURITY;

CREATE POLICY "vip_plans_read_active"
  ON vip_plans
  FOR SELECT
  USING (status = 'active');

COMMENT ON TABLE vip_plans IS 'VIP 套餐表，定义各应用的 VIP 方案';

-- ============================================
-- 9. 用户 VIP 表 (user_vips)
-- ============================================
CREATE TABLE user_vips (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  env text NOT NULL CHECK (env IN ('dev', 'test', 'prod')),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  plan_id uuid NOT NULL REFERENCES vip_plans(id) ON DELETE RESTRICT,
  start_at timestamptz NOT NULL DEFAULT now(),
  end_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'cancelled')),
  source text NOT NULL DEFAULT 'purchase' CHECK (source IN ('purchase', 'admin_grant', 'activity')),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 索引
CREATE INDEX idx_user_vips_user_app_env_status ON user_vips(user_id, app_id, env, status)
  WHERE status = 'active';
CREATE INDEX idx_user_vips_end_at ON user_vips(end_at)
  WHERE status = 'active';

-- RLS
ALTER TABLE user_vips ENABLE ROW LEVEL SECURITY;

CREATE POLICY "user_vips_self_access"
  ON user_vips
  FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

COMMENT ON TABLE user_vips IS '用户 VIP 记录表';

-- ============================================
-- 10. 角色表 (roles)
-- ============================================
CREATE TABLE roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  env text NOT NULL CHECK (env IN ('dev', 'test', 'prod')),
  code text NOT NULL,
  name text NOT NULL,
  UNIQUE(app_id, code, env)
);

-- 索引
CREATE INDEX idx_roles_app_env ON roles(app_id, env);

-- RLS
ALTER TABLE roles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "roles_read"
  ON roles
  FOR SELECT
  TO authenticated
  USING (true);

COMMENT ON TABLE roles IS '角色表，定义各应用的管理角色';

-- ============================================
-- 11. 权限表 (permissions)
-- ============================================
CREATE TABLE permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL
);

-- RLS
ALTER TABLE permissions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "permissions_read"
  ON permissions
  FOR SELECT
  TO authenticated
  USING (true);

COMMENT ON TABLE permissions IS '权限表，全局统一的权限码定义';

-- ============================================
-- 12. 角色权限关联表 (role_permissions)
-- ============================================
CREATE TABLE role_permissions (
  role_id uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id uuid NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

-- 索引
CREATE INDEX idx_role_permissions_role ON role_permissions(role_id);

-- RLS
ALTER TABLE role_permissions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "role_permissions_read"
  ON role_permissions
  FOR SELECT
  TO authenticated
  USING (true);

COMMENT ON TABLE role_permissions IS '角色权限关联表';

-- ============================================
-- 13. 用户角色表 (user_roles)
-- ============================================
CREATE TABLE user_roles (
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  env text NOT NULL CHECK (env IN ('dev', 'test', 'prod')),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  role_id uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (app_id, user_id, role_id, env)
);

-- 索引
CREATE INDEX idx_user_roles_user_app_env ON user_roles(user_id, app_id, env);
CREATE INDEX idx_user_roles_role ON user_roles(role_id);

-- RLS
ALTER TABLE user_roles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "user_roles_self_access"
  ON user_roles
  FOR SELECT
  USING (user_id = auth.uid());

COMMENT ON TABLE user_roles IS '用户角色表，记录用户在各应用的角色分配';

-- ============================================
-- 14. 团队表 (teams)
-- ============================================
CREATE TABLE teams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  env text NOT NULL CHECK (env IN ('dev', 'test', 'prod')),
  name text NOT NULL,
  owner_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'deleted')),
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 索引
CREATE INDEX idx_teams_app_env ON teams(app_id, env);
CREATE INDEX idx_teams_owner ON teams(owner_user_id);

-- 触发器
CREATE TRIGGER update_teams_updated_at
  BEFORE UPDATE ON teams
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- RLS
ALTER TABLE teams ENABLE ROW LEVEL SECURITY;

CREATE POLICY "teams_member_access"
  ON teams
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM team_memberships tm
      WHERE tm.team_id = teams.id
        AND tm.user_id = auth.uid()
        AND tm.status = 'active'
    )
    OR owner_user_id = auth.uid()
  );

COMMENT ON TABLE teams IS '团队表';

-- ============================================
-- 15. 团队成员表 (team_memberships)
-- ============================================
CREATE TABLE team_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  env text NOT NULL CHECK (env IN ('dev', 'test', 'prod')),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  role_in_team text NOT NULL DEFAULT 'member' CHECK (role_in_team IN ('owner', 'admin', 'member')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(team_id, user_id)
);

-- 索引
CREATE INDEX idx_team_memberships_user_app_env ON team_memberships(user_id, app_id, env)
  WHERE status = 'active';
CREATE INDEX idx_team_memberships_team ON team_memberships(team_id)
  WHERE status = 'active';

-- RLS
ALTER TABLE team_memberships ENABLE ROW LEVEL SECURITY;

CREATE POLICY "team_memberships_self_access"
  ON team_memberships
  FOR ALL
  USING (
    user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM teams t
      WHERE t.id = team_memberships.team_id
        AND t.owner_user_id = auth.uid()
    )
  )
  WITH CHECK (user_id = auth.uid());

COMMENT ON TABLE team_memberships IS '团队成员表';

-- ============================================
-- 16. 用户状态变更日志 (user_status_logs)
-- ============================================
CREATE TABLE user_status_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  env text NOT NULL CHECK (env IN ('dev', 'test', 'prod')),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK (action IN ('create', 'ban', 'unban', 'delete')),
  old_status text,
  new_status text,
  operator_user_id uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  remark text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 索引
CREATE INDEX idx_user_status_logs_user_app ON user_status_logs(user_id, app_id, created_at DESC);

-- RLS
ALTER TABLE user_status_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "user_status_logs_self_access"
  ON user_status_logs
  FOR SELECT
  USING (user_id = auth.uid());

COMMENT ON TABLE user_status_logs IS '用户状态变更日志';

-- ============================================
-- 17. 档位变更日志 (user_tier_change_logs)
-- ============================================
CREATE TABLE user_tier_change_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  env text NOT NULL CHECK (env IN ('dev', 'test', 'prod')),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  old_tier text,
  new_tier text,
  old_expires_at timestamptz,
  new_expires_at timestamptz,
  reason text,
  operator_user_id uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 索引
CREATE INDEX idx_user_tier_logs_user_app ON user_tier_change_logs(user_id, app_id, env, created_at DESC);

-- RLS
ALTER TABLE user_tier_change_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "user_tier_change_logs_self_access"
  ON user_tier_change_logs
  FOR SELECT
  USING (user_id = auth.uid());

COMMENT ON TABLE user_tier_change_logs IS '用户档位变更审计日志';

-- ============================================
-- 18. 插入基础权限数据
-- ============================================
INSERT INTO permissions (code, name) VALUES
  ('user.read', '查看用户'),
  ('user.write', '编辑用户'),
  ('user.ban', '封禁/解禁用户'),
  ('user.delete', '删除用户'),
  ('finance.read', '查看财务'),
  ('finance.write', '编辑财务'),
  ('vip.read', '查看 VIP'),
  ('vip.write', '管理 VIP'),
  ('team.read', '查看团队'),
  ('team.write', '管理团队'),
  ('config.read', '查看配置'),
  ('config.write', '编辑配置'),
  ('app.manage', '应用管理'),
  ('super_admin', '超级管理员')
ON CONFLICT (code) DO NOTHING;