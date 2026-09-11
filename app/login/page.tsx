"use client";

import { useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";

const inputStyle: React.CSSProperties = {
  fontFamily: "'IBM Plex Mono', monospace",
  fontSize: 13,
  color: "#fff",
  background: "rgba(255,255,255,.07)",
  border: "1px solid rgba(196,181,253,.24)",
  borderRadius: 10,
  padding: "11px 13px",
  outline: "none",
};

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const r = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || "Sign in failed");
      }
      const next = searchParams.get("next") || "/";
      window.location.href = next;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign in failed");
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background:
          "radial-gradient(1200px 700px at 15% 10%, rgba(124,58,237,.35), transparent 60%), radial-gradient(1000px 700px at 85% 90%, rgba(192,38,211,.3), transparent 60%), #0A0520",
        padding: 20,
      }}
    >
      <form
        onSubmit={onSubmit}
        style={{
          width: "min(380px, 100%)",
          border: "1px solid rgba(196,181,253,.28)",
          borderRadius: 22,
          background: "rgba(12,6,40,.9)",
          backdropFilter: "blur(18px)",
          boxShadow: "0 50px 110px -40px rgba(10,5,32,.95)",
          padding: "34px 30px",
          display: "flex",
          flexDirection: "column",
          gap: 18,
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 6 }}>
          <span
            style={{
              fontFamily: "'IBM Plex Mono', monospace",
              fontSize: 11,
              letterSpacing: ".28em",
              textTransform: "uppercase",
              color: "#C4B5FD",
            }}
          >
            NeoSapients
          </span>
          <span
            style={{
              fontFamily: "Poppins, sans-serif",
              fontWeight: 700,
              fontSize: 24,
              color: "#fff",
              letterSpacing: "-.01em",
            }}
          >
            Sign in to continue
          </span>
        </div>

        <label style={{ display: "flex", flexDirection: "column", gap: 7 }}>
          <span
            style={{
              fontFamily: "'IBM Plex Mono', monospace",
              fontSize: 9.5,
              letterSpacing: ".2em",
              textTransform: "uppercase",
              color: "#C4B5FD",
            }}
          >
            Username
          </span>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoFocus
            style={inputStyle}
          />
        </label>

        <label style={{ display: "flex", flexDirection: "column", gap: 7 }}>
          <span
            style={{
              fontFamily: "'IBM Plex Mono', monospace",
              fontSize: 9.5,
              letterSpacing: ".2em",
              textTransform: "uppercase",
              color: "#C4B5FD",
            }}
          >
            Password
          </span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            style={inputStyle}
          />
        </label>

        {error && (
          <div
            style={{
              fontFamily: "'IBM Plex Mono', monospace",
              fontSize: 11.5,
              letterSpacing: ".04em",
              color: "#FDA4B4",
              border: "1px solid rgba(244,63,94,.4)",
              borderRadius: 10,
              padding: "9px 12px",
            }}
          >
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={busy}
          style={{
            marginTop: 6,
            appearance: "none",
            cursor: busy ? "default" : "pointer",
            border: "1px solid rgba(240,171,252,.55)",
            borderRadius: 999,
            padding: "13px 20px",
            fontFamily: "'IBM Plex Mono', monospace",
            fontSize: 12,
            letterSpacing: ".18em",
            textTransform: "uppercase",
            color: "#fff",
            background: "linear-gradient(100deg,#7C3AED,#C026D3,#7C3AED)",
            backgroundSize: "200% auto",
            opacity: busy ? 0.7 : 1,
            boxShadow: "0 18px 44px -18px rgba(192,38,211,.9)",
          }}
        >
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}

export default function Login() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
