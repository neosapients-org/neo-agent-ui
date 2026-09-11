import { NextResponse } from "next/server";

async function sha256Hex(text: string) {
  const enc = new TextEncoder();
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(text));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function POST(request: Request) {
  const { username, password } = await request.json().catch(() => ({}));
  const user = process.env.SITE_USERNAME || "neoadmin";
  const pass = process.env.SITE_PASSWORD || "Neo@2026";
  const secret = process.env.SESSION_SECRET || "ns-dev-secret-change-me";

  if (username !== user || password !== pass) {
    return NextResponse.json({ error: "Invalid username or password" }, { status: 401 });
  }

  const token = await sha256Hex(`${user}:${pass}:${secret}`);
  const isProd = process.env.NODE_ENV === "production";
  const response = NextResponse.json({ ok: true });
  response.cookies.set("ns_auth", token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    maxAge: 60 * 60 * 5,
    secure: isProd,
  });
  return response;
}
