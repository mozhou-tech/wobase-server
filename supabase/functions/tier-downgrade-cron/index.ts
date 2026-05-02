// ============================================
// Edge Function: tier-downgrade-cron
// 定时任务：扫描过期档位并降级
// ============================================

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.44.0';

serve(async (req) => {
  // 验证请求来源（Vercel Cron 或 Supabase 内部调用）
  const authHeader = req.headers.get('Authorization');
  const cronSecret = Deno.env.get('CRON_SECRET');

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    // 创建 Supabase 客户端
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    const supabase = createClient(supabaseUrl, supabaseServiceKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });

    console.log('Starting tier downgrade cron job...');

    // 查询所有到期的用户档位
    const { data: expiredUsers, error } = await supabase
      .from('app_users')
      .select('app_id, env, user_id, user_tier, tier_expires_at')
      .in('user_tier', ['paid', 'team'])
      .lte('tier_expires_at', new Date().toISOString())
      .eq('app_user_status', 'active');

    if (error) {
      console.error('Failed to query expired users:', error);
      return new Response(
        JSON.stringify({ error: 'Query failed' }),
        { status: 500 }
      );
    }

    if (!expiredUsers || expiredUsers.length === 0) {
      console.log('No expired tiers found');
      return new Response(
        JSON.stringify({ message: 'No expired tiers found', processed: 0 }),
        { status: 200 }
      );
    }

    console.log(`Found ${expiredUsers.length} expired tiers to process`);

    // 批量处理降级
    const results = [];
    for (const user of expiredUsers) {
      try {
        // 调用重新计算函数（会考虑用户是否仍有其他有效订阅）
        const { error: recomputeError } = await supabase.rpc(
          'recompute_app_user_tier',
          {
            p_app_id: user.app_id,
            p_env: user.env,
            p_user_id: user.user_id,
            p_reason: 'cron_tier_expired',
            p_operator_user_id: null,
          }
        );

        if (recomputeError) {
          console.error(`Failed to recompute tier for ${user.user_id}:`, recomputeError);
          results.push({
            user_id: user.user_id,
            status: 'failed',
            error: recomputeError.message,
          });
        } else {
          results.push({
            user_id: user.user_id,
            status: 'success',
          });
        }
      } catch (e) {
        console.error(`Error processing ${user.user_id}:`, e);
        results.push({
          user_id: user.user_id,
          status: 'error',
          error: e.message,
        });
      }
    }

    const successCount = results.filter((r) => r.status === 'success').length;
    const failCount = results.filter((r) => r.status !== 'success').length;

    console.log(`Processed ${successCount} successfully, ${failCount} failed`);

    return new Response(
      JSON.stringify({
        message: 'Tier downgrade completed',
        processed: expiredUsers.length,
        success: successCount,
        failed: failCount,
        results,
      }),
      { status: 200 }
    );
  } catch (error) {
    console.error('Cron job error:', error);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500 }
    );
  }
});