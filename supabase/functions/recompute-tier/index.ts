// ============================================
// Edge Function: recompute-tier
// 重新计算用户档位（整合团队席位和个人 VIP）
// ============================================

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.44.0';
import { z } from 'https://esm.sh/zod@3.23.8';

// 请求参数校验
const requestSchema = z.object({
  app_id: z.string().uuid(),
  env: z.enum(['dev', 'test', 'prod']),
  user_id: z.string().uuid(),
  reason: z.string().optional(),
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
    const body = await req.json();
    const { app_id, env, user_id, reason } = requestSchema.parse(body);

    // 创建 Supabase 客户端（使用 Service Role 绕过 RLS）
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    const supabase = createClient(supabaseUrl, supabaseServiceKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });

    // 调用数据库函数重新计算档位
    const { error } = await supabase.rpc('recompute_app_user_tier', {
      p_app_id: app_id,
      p_env: env,
      p_user_id: user_id,
      p_reason: reason || 'api_call',
      p_operator_user_id: null,
    });

    if (error) {
      console.error('Failed to recompute tier:', error);
      return new Response(
        JSON.stringify({ error: 'Failed to recompute tier' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // 查询更新后的档位
    const { data: appUser, error: queryError } = await supabase
      .from('app_users')
      .select('user_tier, tier_expires_at')
      .eq('app_id', app_id)
      .eq('env', env)
      .eq('user_id', user_id)
      .single();

    if (queryError) {
      return new Response(
        JSON.stringify({ error: 'Failed to query updated tier' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }

    return new Response(
      JSON.stringify({
        success: true,
        data: {
          app_id,
          env,
          user_id,
          user_tier: appUser.user_tier,
          tier_expires_at: appUser.tier_expires_at,
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('Recompute tier error:', error);

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