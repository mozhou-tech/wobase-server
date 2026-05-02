import { NextResponse, type NextRequest } from 'next/server';
import { createRouteClient } from '@/lib/supabase';

// 公开访问的路径（不需要登录）
const PUBLIC_PATHS = [
  '/',
  '/login',
  '/register',
  '/auth/callback',
  '/api/webhook',
  '/api/health',
];

// 静态资源路径前缀
const STATIC_PATHS = ['/_next/', '/static/', '/favicon.ico'];

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // 静态资源直接放行
  if (STATIC_PATHS.some((path) => pathname.startsWith(path))) {
    return NextResponse.next();
  }

  // 公开路径直接放行
  if (PUBLIC_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`))) {
    return NextResponse.next();
  }

  // 创建响应对象
  const response = NextResponse.next();

  // 创建 Supabase 客户端
  const supabase = createRouteClient(request, response);

  // 获取当前用户
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  // 未登录用户重定向到登录页
  if (!user && !pathname.startsWith('/api/')) {
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('redirect', pathname);
    return NextResponse.redirect(loginUrl);
  }

  // API 路由返回 401
  if (!user && pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // 可选：检查用户是否是应用成员
  // 如需此检查，请取消以下注释
  /*
  if (user) {
    const appId = process.env.NEXT_PUBLIC_APP_ID;
    const env = process.env.NEXT_PUBLIC_APP_ENV;

    if (appId && env) {
      const { data: appUser } = await supabase
        .from('app_users')
        .select('app_user_status')
        .eq('app_id', appId)
        .eq('env', env)
        .eq('user_id', user.id)
        .single();

      // 用户不是活跃成员，重定向到等待激活页面
      if (!appUser || appUser.app_user_status !== 'active') {
        if (pathname !== '/pending-activation') {
          return NextResponse.redirect(new URL('/pending-activation', request.url));
        }
      }
    }
  }
  */

  return response;
}

// 配置匹配路径
export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - api/webhook (webhook callbacks)
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - public folder
     */
    '/((?!api/webhook|_next/static|_next/image|favicon.ico|public).*)',
  ],
};