import { NextRequest } from "next/server";

// Runs server-side on Vercel, so this is a plain server-to-server HTTP call — not
// subject to the browser's mixed-content block that stops an https:// page from
// fetching an http:// backend directly. The browser only ever talks to this
// same-origin, HTTPS route.
const AGENT_URLS: Record<string, string> = {
  cortex: process.env.AGENT_CORTEX_URL || "http://184.193.15.193:8000",
  claude: process.env.AGENT_CLAUDE_URL || "http://184.193.15.193:8001",
};

// Chat responses stream token-by-token over SSE and can run well past Vercel's
// default 10s function timeout; this needs a paid plan to actually take effect
// above 10s (Hobby is capped at 10s regardless of this value).
export const maxDuration = 60;

export async function POST(req: NextRequest, { params }: { params: Promise<{ agent: string }> }) {
  const { agent } = await params;
  const base = AGENT_URLS[agent];
  if (!base) {
    return new Response(JSON.stringify({ error: `unknown agent "${agent}"` }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  const body = await req.text();
  let upstream: Response;
  try {
    upstream = await fetch(`${base}/chat/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: `could not reach agent-${agent}: ${(e as Error).message}` }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "Content-Type": upstream.headers.get("Content-Type") || "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
