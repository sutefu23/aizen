import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const AUTH_COOKIE_NAME = "aizen-auth";
const AUTH_TOKEN = process.env.AUTH_TOKEN || "aizen-secret-token";

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // ログインページとAPIは認証不要
  if (pathname === "/login" || pathname === "/api/login") {
    return NextResponse.next();
  }

  const token = request.cookies.get(AUTH_COOKIE_NAME)?.value;

  if (token === AUTH_TOKEN) {
    return NextResponse.next();
  }

  // 未認証 → ログインページへリダイレクト
  const loginUrl = new URL("/login", request.url);
  loginUrl.searchParams.set("from", pathname);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
