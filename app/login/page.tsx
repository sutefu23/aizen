"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";

function LoginForm() {
  const searchParams = useSearchParams();
  const from = searchParams.get("from") || "/release/";
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password, redirectTo: from }),
      });

      const data = await res.json();

      if (res.ok) {
        window.location.href = data.redirectTo;
      } else {
        setError(data.error);
      }
    } catch {
      setError("エラーが発生しました");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={styles.container}>
      <div style={styles.card}>
        <h1 style={styles.title}>AIZEN</h1>
        <p style={styles.subtitle}>閲覧にはパスワードが必要です</p>
        <form onSubmit={handleSubmit}>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="パスワードを入力"
            style={styles.input}
            autoFocus
          />
          {error && <p style={styles.error}>{error}</p>}
          <button type="submit" disabled={loading} style={styles.button}>
            {loading ? "確認中..." : "ログイン"}
          </button>
        </form>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    minHeight: "100vh",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "#f7f4ee",
    fontFamily: "'Noto Sans JP', sans-serif",
  },
  card: {
    background: "#fff",
    padding: "48px 40px",
    borderRadius: "12px",
    boxShadow: "0 2px 16px rgba(0,0,0,0.08)",
    width: "100%",
    maxWidth: "380px",
    textAlign: "center" as const,
  },
  title: {
    fontSize: "28px",
    fontWeight: 700,
    color: "#111009",
    marginBottom: "8px",
    letterSpacing: "0.1em",
  },
  subtitle: {
    fontSize: "14px",
    color: "#6b6356",
    marginBottom: "32px",
  },
  input: {
    width: "100%",
    padding: "12px 16px",
    fontSize: "16px",
    border: "1px solid #ddd8cc",
    borderRadius: "8px",
    outline: "none",
    boxSizing: "border-box" as const,
    marginBottom: "12px",
  },
  error: {
    color: "#c0392b",
    fontSize: "13px",
    marginBottom: "12px",
  },
  button: {
    width: "100%",
    padding: "12px",
    fontSize: "16px",
    fontWeight: 500,
    color: "#fff",
    background: "#c0392b",
    border: "none",
    borderRadius: "8px",
    cursor: "pointer",
  },
};
