// ============================================
// Edge Function: join-app
// 用户加入应用时初始化数据（app_users + user_profiles + wallet_accounts）
// ============================================

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.44.0';
import { z } from 'https://esm.sh/zod@3.23.8';

// 请求参数校验
const requestSchema = z.object({
  app_id: z.string().uuid(),
  env: z.enum(['dev', 'test', 'prod']).default('dev'),
  display_name: z.string().optional(),
  metadata: z.record(z.unknown()).default({}),
});

serve(async (req) => {
  // 仅接受 POST 请求
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    // 解析请求体
    const body = await req.json();
    const { app_id, env, display_name, metadata } = requestSchema.parse(body);

    // 获取 Authorization Header
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 创建 Supabase 客户端
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    const supabase = createClient(supabaseUrl, supabaseServiceKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });

    // 验证用户 Token 并获取用户信息
    const { data: { user }, error: authError } = await supabase.auth.getUser(
      authHeader.replace('Bearer ', '')
    );

    if (authError || !user) {
      return new Response(JSON.stringify({ error: 'Invalid token' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const user_id = user.id;

    // 开始事务操作
    // 1. 检查应用是否存在且活跃
    const { data: app, error: appError } = await supabase
      .from('apps')
      .select('id, status')
      .eq('id', app_id)
      .eq('status', 'active')
      .single();

    if (appError || !app) {
      return new Response(JSON.stringify({ error: 'App not found or inactive' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 2. 创建或更新 app_users 记录（幂等）
    const { error: appUserError } = await supabase
      .from('app_users')
      .upsert(
        {
          app_id,
          user_id,
          env,
          user_tier: 'basic',
          app_user_status: 'active',
          metadata,
        },
        { onConflict: 'app_id,user_id,env' }
      );

    if (appUserError) {
      console.error('Failed to create app_user:', appUserError);
      return new Response(
        JSON.stringify({ error: 'Failed to initialize app membership' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // 3. 创建或更新 user_profiles 记录
    const { error: profileError } = await supabase
      .from('user_profiles')
      .upsert(
        {
          app_id,
          env,
          user_id,
          display_name: display_name || user.user_metadata?.full_name || user.email?.split('@')[0],
          avatar_url: user.user_metadata?.avatar_url,
          metadata: {},
        },
        { onConflict: 'app_id,env,user_id' }
      );

    if (profileError) {
      console.error('Failed to create user_profile:', profileError);
      return new Response(
        JSON.stringify({ error: 'Failed to initialize user profile' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // 4. 预创建钱包账户（可选，按需开启）
    const { error: walletError } = await supabase
      .from('wallet_accounts')
      .upsert(
        [
          { app_id, user_id, env, currency: 'points', available_balance: 0 },
          { app_id, user_id, env, currency: 'CNY', available_balance: 0 },
        ],
        { onConflict: 'app_id,user_id,currency,env' }
      );

    if (walletError) {
      console.error('Failed to create wallet accounts:', walletError);
      // 钱包创建失败不阻塞主流程
    }

    // 5. 记录状态日志
    await supabase.from('user_status_logs').insert({
      app_id,
      env,
      user_id,
      action: 'create',
      old_status: null,
      new_status: 'active',
      operator_user_id: user_id,
      remark: 'User joined app via join-app API',
    });

    return new Response(
      JSON.stringify({
        success: true,
        message: 'Successfully joined app',
        data: {
          app_id,
          user_id,
          env,
          tier: 'basic',
        },
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    console.error('Join app error:', error);

    if (error instanceof z.ZodError) {
      return new Response(
        JSON.stringify({
          error: 'Invalid request data',
          details: error.errors,
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
});