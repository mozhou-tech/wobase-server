import { NextRequest, NextResponse } from 'next/server';

/**
 * 定时任务：扫描过期档位并降级
 * 由 Vercel Cron 触发
 *
 * 配置在 vercel.json 中：
 * crons: [
 *   {
 *     path: "/api/cron/tier-downgrade",
 *     schedule: "每5分钟"
 *   }
 * ]
 */
export async function GET(request: NextRequest) {
  // 验证请求来源（检查 cron secret）
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // 调用 Edge Function 处理降级逻辑
    const response = await fetch(
      `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/tier-downgrade-cron`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cronSecret}`,
          'Content-Type': 'application/json',
        },
      }
    );

    if (!response.ok) {
      const error = await response.text();
      console.error('Cron job failed:', error);
      return NextResponse.json(
        { error: 'Cron job failed', details: error },
        { status: 500 }
      );
    }

    const result = await response.json();

    return NextResponse.json({
      success: true,
      timestamp: new Date().toISOString(),
      result,
    });
  } catch (error) {
    console.error('Cron execution error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}