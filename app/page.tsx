"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";

const THEME_KEY = "theme";

// Rates mirror ns_processor/pricing.py -> "claude-sonnet-5": (input, cache_read, output)
// per million tokens. Kept here rather than in the agents on purpose: the agents must not
// publish a second cost number that can disagree with the dashboard's.
const RATES: Record<string, { in: number; out: number }> = {
  "claude-sonnet-5": { in: 2.0, out: 10.0 },
};
const FALLBACK = { in: 2.0, out: 10.0 };

const AGENTS: Record<string, { url: string }> = {
  cortex: { url: "http://127.0.0.1:8000/chat/stream" },
  claude: { url: "http://127.0.0.1:8001/chat/stream" },
};

// parallel_prep is filtered out of the trail: GUARDRAILS_ENABLED=false, so its
// "Running input safety scan" / "Safety check passed" lines describe a scan that never
// runs. Memory loading does happen in that node, but it is not what the lines claim.
const HIDDEN_STEPS = new Set(["parallel_prep"]);

const CHIPS: [string, string][] = [
  ["cost", "Cost"],
  ["tin", "In"],
  ["tout", "Out"],
  ["ttft", "TTFT"],
  ["lat", "Latency"],
];

function priceOf(model: string, tin: number, tout: number) {
  const r = RATES[model] || FALLBACK;
  return (tin / 1e6) * r.in + (tout / 1e6) * r.out;
}
const fmtCost = (c: number) => "$" + c.toFixed(4);
const fmtTok = (n: number) => (n >= 1000 ? (n / 1000).toFixed(1) + "K" : String(n));
const fmtMs = (ms: number | null) =>
  ms == null ? "—" : ms >= 1000 ? (ms / 1000).toFixed(2) + "s" : ms + "ms";

type TurnMetrics = {
  tin: number;
  tout: number;
  ttft: number | null;
  lat: number | null;
  cost: number | null;
  t0: number;
  first: boolean;
};

type AnswerNode = {
  steps: HTMLDivElement;
  answer: HTMLDivElement;
  metrics: HTMLDivElement;
  body: HTMLDivElement;
  provisional: HTMLDivElement | null;
  tick: ReturnType<typeof setInterval> | null;
};

export default function ComparePage() {
  const qRef = useRef<HTMLTextAreaElement>(null);
  const sendRef = useRef<HTMLButtonElement>(null);
  const bodyCortexRef = useRef<HTMLDivElement>(null);
  const bodyClaudeRef = useRef<HTMLDivElement>(null);
  const stCortexRef = useRef<HTMLSpanElement>(null);
  const stClaudeRef = useRef<HTMLSpanElement>(null);

  const [theme, setTheme] = useState<"dark" | "light">(() => {
    if (typeof window === "undefined") return "dark";
    return (localStorage.getItem(THEME_KEY) as "dark" | "light") ?? "dark";
  });

  // React Strict Mode remounts once in dev and resets <html> to only the attributes
  // it manages from JSX, clearing whatever the inline head script set. Re-apply here
  // so dev doesn't show a different theme than the persisted preference. No-op in prod.
  useLayoutEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  function toggleTheme() {
    const next = theme === "dark" ? "light" : "dark";
    localStorage.setItem(THEME_KEY, next);
    setTheme(next);
  }

  // Kept as an imperative, DOM-driven implementation deliberately: it mirrors the
  // original agent-compare/index.html script closely so the streaming/metrics logic
  // (already verified working there) doesn't get re-derived and risk drifting.
  useEffect(() => {
    const turn: Record<string, TurnMetrics> = {};
    let busy = false;

    const bodies: Record<string, HTMLDivElement> = {
      cortex: bodyCortexRef.current!,
      claude: bodyClaudeRef.current!,
    };
    const statuses: Record<string, HTMLSpanElement> = {
      cortex: stCortexRef.current!,
      claude: stClaudeRef.current!,
    };

    function resetPanel(v: string) {
      turn[v] = { tin: 0, tout: 0, ttft: null, lat: null, cost: null, t0: performance.now(), first: false };
    }

    function addUser(v: string, text: string) {
      const b = bodies[v];
      const msg = document.createElement("div");
      msg.className = "msg";
      const who = document.createElement("div");
      who.className = "who";
      who.textContent = "You";
      const bubble = document.createElement("div");
      bubble.className = "bubble";
      bubble.textContent = text;
      msg.append(who, bubble);
      b.appendChild(msg);
      b.scrollTop = b.scrollHeight;
    }

    function startAnswer(v: string): AnswerNode {
      const b = bodies[v];
      const msg = document.createElement("div");
      msg.className = "msg";

      const who = document.createElement("div");
      who.className = "who";
      who.textContent = `agent-${v}`;

      const steps = document.createElement("div");
      steps.className = "steps";

      const answer = document.createElement("div");
      answer.className = "answer streaming";

      const metrics = document.createElement("div");
      metrics.className = "rmetrics pending";
      for (const [k, label] of CHIPS) {
        const chip = document.createElement("span");
        chip.className = "chip" + (k === "cost" ? " cost" : "");
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

      msg.append(who, steps, answer, metrics);
      b.appendChild(msg);
      b.scrollTop = b.scrollHeight;

      const node: AnswerNode = { steps, answer, metrics, body: b, provisional: null, tick: null };

      // Enrichment is an LLM call taking 3-4s and its step is only emitted once that call
      // returns. Without a marker the panel sits blank and looks stalled.
      addStep(node, "intent enrichment", "Analysing the question… 0.0s", true);
      const row = node.provisional!;
      const t0 = performance.now();
      node.tick = setInterval(() => {
        if (!node.provisional) {
          clearInterval(node.tick!);
          return;
        }
        row.lastChild!.textContent = `Analysing the question… ${((performance.now() - t0) / 1000).toFixed(1)}s`;
      }, 100);

      return node;
    }

    function addStep(node: AnswerNode, tool: string, text: string, provisional?: boolean) {
      if (HIDDEN_STEPS.has(tool)) return;
      if (node.provisional) {
        node.provisional.remove();
        node.provisional = null;
        if (node.tick) {
          clearInterval(node.tick);
          node.tick = null;
        }
      }
      const row = document.createElement("div");
      row.className = "step";
      const t = document.createElement("span");
      t.className = "t";
      t.textContent = (tool || "").replace(/_/g, " ");
      const d = document.createElement("span");
      d.textContent = text || "";
      row.append(t, d);
      node.steps.appendChild(row);
      if (provisional) node.provisional = row;
      node.body.scrollTop = node.body.scrollHeight;
    }

    function setChip(node: AnswerNode, k: string, text: string) {
      const el = node.metrics.querySelector<HTMLElement>(`[data-k="${k}"]`);
      if (el) el.textContent = text;
    }

    async function ask(v: string, question: string, session: string) {
      const st = statuses[v];
      st.textContent = "running";
      st.className = "status live";
      const node = startAnswer(v);
      const m = turn[v];

      let res: Response;
      try {
        res = await fetch(AGENTS[v].url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: question, user_id: "compare", session_id: session }),
        });
      } catch (e) {
        node.answer.classList.remove("streaming");
        node.answer.textContent = "Could not reach the agent: " + (e as Error).message;
        if (node.provisional) {
          node.provisional.remove();
          node.provisional = null;
        }
        if (node.tick) {
          clearInterval(node.tick);
          node.tick = null;
        }
        st.textContent = "unreachable";
        st.className = "status err";
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
              setChip(node, "ttft", fmtMs(m.ttft));
            }
            node.answer.textContent += d.content;
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
            if (d.ttft_ms != null) {
              m.ttft = d.ttft_ms;
              setChip(node, "ttft", fmtMs(m.ttft));
            }
          } else if (event === "error") {
            node.answer.textContent += "\n[error] " + (d.message || "");
            st.textContent = "error";
            st.className = "status err";
          }
        }
      }

      m.lat = Math.round(performance.now() - m.t0);
      setChip(node, "lat", fmtMs(m.lat));
      node.metrics.classList.remove("pending");
      if (node.provisional) {
        node.provisional.remove();
        node.provisional = null;
      }
      if (node.tick) {
        clearInterval(node.tick);
        node.tick = null;
      }
      node.answer.classList.remove("streaming");
      if (st.className !== "status err") {
        st.textContent = "done";
        st.className = "status";
      }
    }

    async function send() {
      const q = qRef.current!;
      const sendBtn = sendRef.current!;
      const text = q.value.trim();
      if (!text || busy) return;
      busy = true;
      sendBtn.disabled = true;
      q.value = "";
      const session = "cmp-" + Date.now();

      ["cortex", "claude"].forEach((v) => {
        resetPanel(v);
        addUser(v, text);
      });

      // Both fired together so neither gets a warm-cache advantage from going second.
      await Promise.allSettled([
        ask("cortex", text, session + "-cortex"),
        ask("claude", text, session + "-claude"),
      ]);

      busy = false;
      sendBtn.disabled = false;
      q.focus();
    }

    const q = qRef.current!;
    const sendBtn = sendRef.current!;

    const onSendClick = () => send();
    const onKeydown = (e: KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    };
    const onInput = () => {
      q.style.height = "auto";
      q.style.height = Math.min(q.scrollHeight, 130) + "px";
    };

    sendBtn.addEventListener("click", onSendClick);
    q.addEventListener("keydown", onKeydown);
    q.addEventListener("input", onInput);
    q.focus();

    return () => {
      sendBtn.removeEventListener("click", onSendClick);
      q.removeEventListener("keydown", onKeydown);
      q.removeEventListener("input", onInput);
    };
  }, []);

  return (
    <>
      <header>
        <div className="brand">
          <div className="dot">AB</div>
          <h1>
            agent-cortex <span>vs</span> agent-claude
          </h1>
        </div>
        <div className="spacer" />
        <button className="theme-toggle" onClick={toggleTheme} type="button">
          {theme === "dark" ? "☀ Light" : "🌙 Dark"}
        </button>
      </header>

      <div id="split">
        <section className="panel" data-v="cortex">
          <div className="phead">
            <span className="pdot" />
            <h2>agent-cortex</h2>
            <span className="port">:8000 · via Cortex platform</span>
            <span className="status" ref={stCortexRef}>
              idle
            </span>
          </div>
          <div className="body" ref={bodyCortexRef} />
        </section>

        <section className="panel" data-v="claude">
          <div className="phead">
            <span className="pdot" />
            <h2>agent-claude</h2>
            <span className="port">:8001 · direct SQL</span>
            <span className="status" ref={stClaudeRef}>
              idle
            </span>
          </div>
          <div className="body" ref={bodyClaudeRef} />
        </section>
      </div>

      <footer>
        <div className="composer">
          <textarea id="q" ref={qRef} rows={1} placeholder="Ask both agents the same question…" />
          <button ref={sendRef} id="send">
            Send
          </button>
        </div>
      </footer>
    </>
  );
}
