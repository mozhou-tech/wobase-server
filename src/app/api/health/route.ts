import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase';

/**
 * 健康检查端点
 * 用于监控和负载均衡检查
 */
export async function GET() {
  const startTime = Date.now();

  try {
    // 检查数据库连接
    const supabase = createServiceClient();
    const { data, error } = await supabase.from('apps').select('count').limit(1);

    if (error) {
      console.error('Health check failed:', error);
      return NextResponse.json(
        {
          status: 'unhealthy',
          timestamp: new Date().toISOString(),
          checks: {
            database: 'failed',
            error: error.message,
          },
        },
        { status: 503 }
      );
    }

    const responseTime = Date.now() - startTime;

    return NextResponse.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      responseTime: `${responseTime}ms`,
      checks: {
        database: 'ok',
      },
      version: process.env.npm_package_version || '0.1.0',
    });
  } catch (error) {
    console.error('Health check error:', error);
    return NextResponse.json(
      {
        status: 'unhealthy',
        timestamp: new Date().toISOString(),
        checks: {
          database: 'error',
          error: error instanceof Error ? error.message : 'Unknown error',
        },
      },
      { status: 503 }
    );
  }
}