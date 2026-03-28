import { NextRequest, NextResponse } from "next/server";

const AUTH_PASSWORD = process.env.AUTH_PASSWORD || "aizen";
const AUTH_TOKEN = process.env.AUTH_TOKEN || "aizen-secret-token";
const AUTH_COOKIE_NAME = "aizen-auth";

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { password } = body;

  if (password !== AUTH_PASSWORD) {
    return NextResponse.json({ error: "パスワードが違います" }, { status: 401 });
  }

  const redirectTo = body.redirectTo || "/release/";
  const response = NextResponse.json({ success: true, redirectTo });

  response.cookies.set(AUTH_COOKIE_NAME, AUTH_TOKEN, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30, // 30日間
  });

  return response;
}
