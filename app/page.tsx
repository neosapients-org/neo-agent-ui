"use client";

import { useRef, useState } from "react";

const THEME_KEY = "theme";

// Rates mirror ns_processor/pricing.py -> "claude-sonnet-5": (input, cache_read, output)
// per million tokens. Kept here rather than in the agents on purpose: the agents must not
// publish a second cost number that can disagree with the dashboard's.
const RATES: Record<string, { in: number; out: number }> = {
  "claude-sonnet-5": { in: 2.0, out: 10.0 },
};
const FALLBACK = { in: 2.0, out: 10.0 };

// Same-origin, relative paths — proxied server-side by app/api/[agent]/chat/stream/route.ts.
// A direct browser fetch to the agents' http:// EC2 URLs gets silently blocked as mixed
// content once this UI is served over https:// (e.g. on Vercel); routing through this
// app's own API keeps the browser talking to one HTTPS origin.
const AGENTS: Record<string, { url: string }> = {
  cortex: { url: "/api/cortex/chat/stream" },
  claude: { url: "/api/claude/chat/stream" },
};

// GUARDRAILS_ENABLED=false, so parallel_prep's step text describes a safety scan that
// never runs. Memory loading does happen in that node, but it isn't what the line claims.
const HIDDEN_STEPS = new Set(["parallel_prep"]);

const BASE_CHIPS: [string, string][] = [
  ["cost", "Cost"],
  ["tin", "In"],
  ["tout", "Out"],
  ["ttft", "TTFT"],
  ["lat", "Latency"],
];

// `allcost` adds what the Cortex platform burnt resolving the data to the agent's own
// spend, and `ptok` is that platform's token count. Ordered so the two money chips sit
// side by side: the pair is the comparison, and a reader should not have to hunt across
// the row for it.
const PLATFORM_CHIPS: [string, string][] = [
  ["allcost", "Agent+Platform"],
  ["ptok", "Cortex tok"],
];

// Only agent-cortex gets the platform chips. agent-claude reaches the database directly
// (DATA_RESOLVER=direct, empty MCP_URL) — there is no platform in its path, so for it
// `Cost` IS the total and a permanently blank "Agent+Platform" would read as a missing
// measurement rather than as the architectural difference the comparison is about.
function chipsFor(agent: string): [string, string][] {
  return agent === "cortex"
    ? [BASE_CHIPS[0], ...PLATFORM_CHIPS, ...BASE_CHIPS.slice(1)]
    : BASE_CHIPS;
}

function priceOf(model: string, tin: number, tout: number) {
  const r = RATES[model] || FALLBACK;
  return (tin / 1e6) * r.in + (tout / 1e6) * r.out;
}
const fmtCost = (c: number) => "$" + c.toFixed(4);
const fmtTok = (n: number) => (n >= 1000 ? (n / 1000).toFixed(1) + "K" : String(n));
const fmtMs = (ms: number | null) =>
  ms == null ? "—" : ms >= 1000 ? (ms / 1000).toFixed(2) + "s" : ms + "ms";

// The agents are prompted to answer with markdown tables for multi-row data (see
// app/graph/nodes/generate.py). Escaped first — the text comes from a model summarising
// database rows, so it must not be able to inject markup — then a small subset of
// markdown (tables, bold, code, bullets) is converted to real HTML.
function renderMarkdown(raw: string): string {
  const escaped = raw.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const lines = escaped.split("\n");
  const out: string[] = [];

  const splitRow = (line: string) =>
    line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
  const inline = (text: string) =>
    text
      .replace(/`([^`\n]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>");

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const isRow = /^\s*\|.*\|\s*$/.test(line);
    const sepLine = lines[i + 1] ?? "";
    const isSep = /^\s*\|?[\s:|-]+\|?\s*$/.test(sepLine) && sepLine.includes("-");

    if (isRow && isSep) {
      const header = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      out.push(
        `<div class="markdownTableWrap"><table class="markdownTable">` +
          `<thead class="markdownThead"><tr>${header
            .map((h) => `<th class="markdownTh">${inline(h)}</th>`)
            .join("")}</tr></thead>` +
          `<tbody>${rows
            .map(
              (r) =>
                `<tr class="markdownTr">${r
                  .map((c) => `<td class="markdownTd">${inline(c)}</td>`)
                  .join("")}</tr>`
            )
            .join("")}</tbody></table></div>`
      );
      continue;
    }

    out.push(inline(line).replace(/^\s*[-*]\s+(.*)$/, "• $1"));
    i++;
  }
  return out.join("\n");
}

type TurnMetrics = {
  tin: number;
  tout: number;
  ttft: number | null;
  lat: number | null;
  cost: number | null;
  // Platform-side spend, priced by the gateway rather than here. null means the
  // platform reported nothing — a cache-served turn, or agent-claude, which has no
  // platform at all — and is rendered "—". It is NOT the same as 0.
  pcost: number | null;
  ptok: number | null;
  t0: number;
  first: boolean;
};

type AnswerNode = {
  thoughtIndicator: HTMLSpanElement;
  thoughtLabel: HTMLSpanElement;
  thoughtArrow: HTMLSpanElement;
  thoughtContent: HTMLDivElement;
  answer: HTMLDivElement;
  metrics: HTMLDivElement;
  body: HTMLDivElement;
  tick: ReturnType<typeof setInterval> | null;
  raw: string;
};

export default function ComparePage() {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const bodyCortexRef = useRef<HTMLDivElement>(null);
  const bodyClaudeRef = useRef<HTMLDivElement>(null);
  const stCortexRef = useRef<HTMLSpanElement>(null);
  const stClaudeRef = useRef<HTMLSpanElement>(null);
  const turnRef = useRef<Record<string, TurnMetrics>>({});
  const busyRef = useRef(false);

  const [theme, setTheme] = useState<"dark" | "light">(() => {
    if (typeof window === "undefined") return "light";
    return (localStorage.getItem(THEME_KEY) as "dark" | "light") ?? "light";
  });
  const [question, setQuestion] = useState("");
  const [started, setStarted] = useState(false);
  const [busy, setBusy] = useState(false);

  function applyTheme(next: "dark" | "light") {
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem(THEME_KEY, next);
    setTheme(next);
  }
  const toggleTheme = () => applyTheme(theme === "dark" ? "light" : "dark");

  const bodies = (): Record<string, HTMLDivElement> => ({
    cortex: bodyCortexRef.current!,
    claude: bodyClaudeRef.current!,
  });
  const statuses = (): Record<string, HTMLSpanElement> => ({
    cortex: stCortexRef.current!,
    claude: stClaudeRef.current!,
  });

  function resetPanel(v: string) {
    turnRef.current[v] = {
      tin: 0,
      tout: 0,
      ttft: null,
      lat: null,
      cost: null,
      pcost: null,
      ptok: null,
      t0: performance.now(),
      first: false,
    };
  }

  function addUser(v: string, text: string) {
    const b = bodies()[v];
    const row = document.createElement("div");
    row.className = "messageRow messageRowUser";
    const bubble = document.createElement("div");
    bubble.className = "messageBubble messageBubbleUser";
    bubble.textContent = text;
    row.appendChild(bubble);
    b.appendChild(row);
    b.scrollTop = b.scrollHeight;
  }

  function startAnswer(v: string): AnswerNode {
    const b = bodies()[v];
    const row = document.createElement("div");
    row.className = "messageRow messageRowAssistant";

    const avatar = document.createElement("div");
    avatar.className = "assistantAvatar";
    const img = document.createElement("img");
    img.src = "/mascot.webp";
    img.alt = `agent-${v}`;
    avatar.appendChild(img);

    const bubble = document.createElement("div");
    bubble.className = "messageBubbleAssistant";

    const thoughtBlock = document.createElement("div");
    thoughtBlock.className = "thoughtBlock";
    const thoughtHeader = document.createElement("div");
    thoughtHeader.className = "thoughtHeader";
    const thoughtIndicator = document.createElement("span");
    thoughtIndicator.className = "thoughtIndicator pending";
    const thoughtLabel = document.createElement("span");
    thoughtLabel.className = "thoughtLabel";
    thoughtLabel.textContent = "Analysing the question… 0.0s";
    const thoughtArrow = document.createElement("span");
    thoughtArrow.className = "thoughtArrow";
    thoughtArrow.textContent = "▸";
    thoughtHeader.append(thoughtIndicator, thoughtLabel, thoughtArrow);

    const thoughtContent = document.createElement("div");
    thoughtContent.className = "thoughtContent collapsed";

    thoughtHeader.addEventListener("click", () => {
      thoughtContent.classList.toggle("collapsed");
      thoughtArrow.classList.toggle("open");
    });

    thoughtBlock.append(thoughtHeader, thoughtContent);

    const answer = document.createElement("div");
    answer.className = "answer streaming";

    const metrics = document.createElement("div");
    metrics.className = "rmetrics pending";
    for (const [k, label] of chipsFor(v)) {
      const chip = document.createElement("span");
      // Both money chips get the accent treatment, so the pair reads as one unit and
      // the agent-only figure is never mistaken for the turn's full cost.
      chip.className = "chip" + (k === "cost" || k === "allcost" ? " cost" : "");
      const kEl = document.createElement("span");
      kEl.className = "k";
      kEl.textContent = label;
      const vEl = document.createElement("span");
      vEl.className = "v";
      vEl.dataset.k = k;
      vEl.textContent = "—";
      chip.append(kEl, vEl);
      metrics.appendChild(chip);
    }

    bubble.append(thoughtBlock, answer, metrics);
    row.append(avatar, bubble);
    b.appendChild(row);
    b.scrollTop = b.scrollHeight;

    const node: AnswerNode = {
      thoughtIndicator,
      thoughtLabel,
      thoughtArrow,
      thoughtContent,
      answer,
      metrics,
      body: b,
      tick: null,
      raw: "",
    };

    const t0 = performance.now();
    node.tick = setInterval(() => {
      thoughtLabel.textContent = `Analysing the question… ${((performance.now() - t0) / 1000).toFixed(1)}s`;
    }, 100);

    return node;
  }

  function addStep(node: AnswerNode, tool: string, text: string) {
    if (HIDDEN_STEPS.has(tool)) return;
    const row = document.createElement("div");
    row.className = "step";
    const t = document.createElement("span");
    t.className = "t";
    t.textContent = (tool || "").replace(/_/g, " ");
    const d = document.createElement("span");
    d.textContent = text || "";
    row.append(t, d);
    node.thoughtContent.appendChild(row);
    node.body.scrollTop = node.body.scrollHeight;
  }

  function setChip(node: AnswerNode, k: string, text: string) {
    const el = node.metrics.querySelector<HTMLElement>(`[data-k="${k}"]`);
    if (el) el.textContent = text;
  }

  async function ask(v: string, question: string, session: string) {
    const st = statuses()[v];
    st.textContent = "running";
    st.className = "columnStatus live";
    const node = startAnswer(v);
    const m = turnRef.current[v];

    let res: Response;
    try {
      res = await fetch(AGENTS[v].url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: question, user_id: "compare", session_id: session }),
      });
    } catch (e) {
      if (node.tick) clearInterval(node.tick);
      node.thoughtLabel.textContent = "Unreachable";
      node.thoughtIndicator.classList.remove("pending");
      node.answer.classList.remove("streaming");
      node.answer.textContent = "Could not reach the agent: " + (e as Error).message;
      st.textContent = "unreachable";
      st.className = "columnStatus err";
      return;
    }

    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let event: string | null = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";

      for (const line of lines) {
        if (line.startsWith("event:")) {
          event = line.slice(6).trim();
          continue;
        }
        if (!line.startsWith("data:")) continue;
        let d: any;
        try {
          d = JSON.parse(line.slice(5).trim());
        } catch {
          continue;
        }

        if (event === "token" && d.content) {
          if (!m.first) {
            m.first = true;
            m.ttft = Math.round(performance.now() - m.t0);
            if (node.tick) {
              clearInterval(node.tick);
              node.tick = null;
            }
            node.thoughtIndicator.classList.remove("pending");
            node.thoughtLabel.textContent = `Time to first token: ${(m.ttft / 1000).toFixed(1)}s`;
          }
          node.raw += d.content;
          node.answer.innerHTML = renderMarkdown(node.raw);
          node.body.scrollTop = node.body.scrollHeight;
        } else if (event === "step_detail") {
          addStep(node, d.tool, d.text);
        } else if (event === "usage") {
          m.tin = d.input_tokens || 0;
          m.tout = d.output_tokens || 0;
          m.cost = priceOf(d.model, m.tin, m.tout);
          node.metrics.classList.remove("pending");
          setChip(node, "tin", fmtTok(m.tin));
          setChip(node, "tout", fmtTok(m.tout));
          setChip(node, "cost", fmtCost(m.cost));
          // The platform's own spend, when the gateway reported it. Its cost is used
          // as given rather than run through priceOf(): only the gateway knows which
          // models its phases used, and it has already priced each at list rate. The
          // whole key is absent — never zeroed — when no platform LLM ran, so the
          // chips are left at "—" rather than being made to claim a free turn.
          if (d.platform) {
            m.pcost = d.platform.total_cost_usd ?? 0;
            m.ptok = d.platform.total_tokens ?? 0;
            setChip(node, "allcost", fmtCost(m.cost + (m.pcost as number)));
            setChip(node, "ptok", fmtTok(m.ptok as number));
          }
          if (d.ttft_ms != null) {
            const ttft: number = d.ttft_ms;
            m.ttft = ttft;
            node.thoughtLabel.textContent = `Time to first token: ${(ttft / 1000).toFixed(1)}s`;
            setChip(node, "ttft", fmtMs(ttft));
          }
        } else if (event === "error") {
          const err = document.createElement("div");
          err.className = "errorBox";
          err.textContent = d.message || "The agent reported an error.";
          node.answer.after(err);
          st.textContent = "error";
          st.className = "columnStatus err";
        }
      }
    }

    m.lat = Math.round(performance.now() - m.t0);
    setChip(node, "lat", fmtMs(m.lat));
    node.metrics.classList.remove("pending");
    if (node.tick) {
      clearInterval(node.tick);
      node.tick = null;
    }
    if (!m.first) node.thoughtLabel.textContent = "No response";
    node.thoughtIndicator.classList.remove("pending");
    node.answer.classList.remove("streaming");
    if (st.className !== "columnStatus err") {
      st.textContent = "done";
      st.className = "columnStatus";
    }
  }

  async function handleSend(text?: string) {
    const val = (text ?? question).trim();
    if (!val || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setQuestion("");
    if (!started) setStarted(true);

    const session = "cmp-" + Date.now();
    ["cortex", "claude"].forEach((v) => {
      resetPanel(v);
      addUser(v, val);
    });

    // Both fired together so neither gets a warm-cache advantage from going second.
    await Promise.allSettled([
      ask("cortex", val, session + "-cortex"),
      ask("claude", val, session + "-claude"),
    ]);

    busyRef.current = false;
    setBusy(false);
    textareaRef.current?.focus();
  }

  function goHome() {
    // Guarded while a stream is in flight: the in-progress ask() calls hold direct
    // references to the DOM nodes being cleared here, and letting them keep writing
    // into detached nodes after a reset would leave the status pills in a stale state.
    if (busyRef.current) return;
    bodyCortexRef.current!.innerHTML = "";
    bodyClaudeRef.current!.innerHTML = "";
    for (const st of [stCortexRef.current!, stClaudeRef.current!]) {
      st.textContent = "idle";
      st.className = "columnStatus";
    }
    setQuestion("");
    setStarted(false);
  }

  function onTextareaInput(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setQuestion(e.target.value);
    e.target.style.height = "auto";
    e.target.style.height = Math.min(e.target.scrollHeight, 130) + "px";
  }
  function onTextareaKeydown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  const composer = (
    <div className="inputAreaBox">
      <textarea
        ref={textareaRef}
        className="textarea"
        rows={1}
        placeholder="Ask both agents anything…"
        value={question}
        onChange={onTextareaInput}
        onKeyDown={onTextareaKeydown}
        disabled={busy}
      />
      <button
        className="sendBtn"
        type="button"
        onClick={() => handleSend()}
        disabled={!question.trim() || busy}
        title="Send to both agents"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="22" y1="2" x2="11" y2="13" />
          <polygon points="22 2 15 22 11 13 2 9 22 2" />
        </svg>
      </button>
    </div>
  );

  return (
    <>
      <header className="header">
        <button type="button" className="brand" onClick={goHome} title="Back to home" aria-label="Back to home">
          <img src="/neowealth-logo.svg" alt="NeoWealth" className="brandLogo" />
        </button>
        <div className="headerRight">
          <button className="themeToggle" onClick={toggleTheme} type="button" title="Toggle theme">
            {theme === "dark" ? (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="5" />
                <line x1="12" y1="1" x2="12" y2="3" /><line x1="12" y1="21" x2="12" y2="23" />
                <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" /><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
                <line x1="1" y1="12" x2="3" y2="12" /><line x1="21" y1="12" x2="23" y2="12" />
                <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" /><line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
              </svg>
            ) : (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
              </svg>
            )}
          </button>
        </div>
      </header>

      <main className="chatBoard">
        {/* The hero mounts/unmounts freely — it holds no ref that outlives a render.
            compareColumns, by contrast, stays permanently mounted (just hidden via CSS
            until the first send) because the async ask() calls write into its column
            refs directly; if it only mounted after `started` flipped true, the very
            first send would race the re-render and find the refs still null. */}
        {!started && (
          <div className="heroWrap">
            <div className="heroAvatar">
              <img className="heroImg" src="/mascot.webp" alt="NeoWealth assistant" />
            </div>
            <h1 className="heroTitle">Hello! Great to see you. What's the focus for today?</h1>
            <div className="heroInput">{composer}</div>
          </div>
        )}

        <div className="compareColumns" style={{ display: started ? "grid" : "none" }}>
          <section className="column" data-agent="claude">
            <div className="columnHead">
              <span className="columnDot" />
              <h2>Only Claude</h2>
              <span className="columnStatus" ref={stClaudeRef}>idle</span>
            </div>
            <div className="chatMessages" ref={bodyClaudeRef} />
          </section>
          <section className="column" data-agent="cortex">
            <div className="columnHead">
              <span className="columnDot" />
              <h2>Claude + NeoSapients</h2>
              <span className="columnStatus" ref={stCortexRef}>idle</span>
            </div>
            <div className="chatMessages" ref={bodyCortexRef} />
          </section>
        </div>
      </main>

      {started && <div className="inputAreaContainer">{composer}</div>}
    </>
  );
}
