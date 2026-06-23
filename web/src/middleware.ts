import { NextResponse } from "next/server";

// 桌面本机单用户·免登录：已删 SaaS 登录鉴权，不再做 token 门，全部放行。
export function middleware() {
  return NextResponse.next();
}

export const config = {
  matcher: ["/dashboard/:path*"],
};