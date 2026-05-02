-- ============================================
-- 初始化扩展和基础函数
-- 适用于: Supabase Postgres 15+
-- ============================================

-- 1. 启用必要的扩展
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_cron";

-- TimescaleDB 扩展（如需时序数据支持，在 Supabase Dashboard 启用）
-- CREATE EXTENSION IF NOT EXISTS "timescaledb";

-- 2. 自动更新时间戳函数
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 3. 检查函数（用于 RLS 策略）
CREATE OR REPLACE FUNCTION is_valid_env(env text)
RETURNS boolean
LANGUAGE sql STABLE
AS $$
  SELECT env IN ('dev', 'test', 'prod');
$$;

-- 4. 权限控制
REVOKE ALL ON FUNCTION update_updated_at_column() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION update_updated_at_column() TO authenticated, service_role;

REVOKE ALL ON FUNCTION is_valid_env(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION is_valid_env(text) TO authenticated, service_role, anon;

-- 5. 注释
COMMENT ON FUNCTION update_updated_at_column() IS '自动更新时间戳触发器函数';
COMMENT ON FUNCTION is_valid_env(text) IS '验证环境标识是否有效';