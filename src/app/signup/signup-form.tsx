"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { signIn } from "next-auth/react";

export function SignupForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);

    const res = await fetch("/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, name: name || undefined }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setError(body?.error?.message ?? "Sign-up failed. Please try again.");
      setBusy(false);
      return;
    }

    const result = await signIn("credentials", { email, password, redirect: false });
    setBusy(false);
    if (result?.error) {
      setError("Account created, but sign-in failed. Try signing in.");
      return;
    }
    router.push("/dashboard");
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="form-stack">
      <input
        type="text"
        placeholder="Name (optional)"
        autoComplete="name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="field"
      />
      <input
        type="email"
        required
        placeholder="Email"
        autoComplete="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        className="field"
      />
      <input
        type="password"
        required
        minLength={8}
        placeholder="Password (8+ characters)"
        autoComplete="new-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        className="field"
      />
      {error && <p className="error-text">{error}</p>}
      <button type="submit" disabled={busy} className="btn-primary">
        {busy ? "Creating account…" : "Sign up"}
      </button>
    </form>
  );
}
