"use client";

import { useCallback, useEffect, useState } from "react";
import { usePlaidLink } from "react-plaid-link";

type Account = {
  id: string;
  name: string;
  type: string;
  mask: string | null;
  currency: string;
};

type Connection = {
  id: string;
  institution: string | null;
  status: string;
  last_synced_at: string | null;
  accounts: Account[];
};

const STATUS_LABELS: Record<string, string> = {
  pending: "Connected — sync coming soon",
  syncing: "Syncing…",
  ready: "Up to date",
  ok: "Up to date",
  reauth_required: "Needs re-authentication",
  degraded: "Having trouble syncing",
  revoking: "Disconnecting…",
};

export function ConnectionsPanel() {
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const res = await fetch("/api/connections");
    if (res.ok) {
      const body = await res.json();
      setConnections(body.connections);
    }
  }, []);

  useEffect(() => {
    void refresh();
    void (async () => {
      const res = await fetch("/api/connections/link-token", { method: "POST" });
      if (res.ok) {
        const body = await res.json();
        setLinkToken(body.link_token);
      } else {
        setError("Could not initialize bank connection.");
      }
    })();
  }, [refresh]);

  const onSuccess = useCallback(
    async (publicToken: string) => {
      setBusy(true);
      setError(null);
      const res = await fetch("/api/connections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ public_token: publicToken }),
      });
      setBusy(false);
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(body?.error?.message ?? "Connecting the bank failed.");
        return;
      }
      await refresh();
    },
    [refresh],
  );

  const { open, ready } = usePlaidLink({
    token: linkToken,
    onSuccess: (public_token) => void onSuccess(public_token),
  });

  async function disconnect(connection: Connection) {
    const label = connection.institution ?? "this bank";
    if (!window.confirm(`Disconnect ${label}? Its data will be removed.`)) return;
    const res = await fetch(`/api/connections/${connection.id}`, { method: "DELETE" });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setError(body?.error?.message ?? "Disconnecting failed.");
      return;
    }
    await refresh();
  }

  return (
    <section style={{ marginTop: "2rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h2 style={{ margin: 0 }}>Banks</h2>
        <button
          type="button"
          onClick={() => open()}
          disabled={!ready || busy}
          style={{ padding: "0.5rem 1rem" }}
        >
          {busy ? "Connecting…" : "Connect a bank"}
        </button>
      </div>

      {error && <p style={{ color: "crimson" }}>{error}</p>}

      {connections === null ? (
        <p style={{ color: "#666" }}>Loading…</p>
      ) : connections.length === 0 ? (
        <p style={{ color: "#666" }}>
          No banks connected yet. Connect one to start finding your subscriptions.
        </p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0 }}>
          {connections.map((c) => (
            <li
              key={c.id}
              style={{
                border: "1px solid #ddd",
                borderRadius: 8,
                padding: "1rem",
                marginTop: "0.75rem",
              }}
            >
              <div
                style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}
              >
                <strong>{c.institution ?? "Bank"}</strong>
                <span style={{ color: "#666", fontSize: "0.9rem" }}>
                  {STATUS_LABELS[c.status] ?? c.status}
                </span>
              </div>
              <ul style={{ listStyle: "none", padding: 0, marginTop: "0.5rem", color: "#444" }}>
                {c.accounts.map((a) => (
                  <li key={a.id}>
                    {a.name} {a.mask ? `••••${a.mask}` : ""} · {a.type} · {a.currency}
                  </li>
                ))}
              </ul>
              <button
                type="button"
                onClick={() => void disconnect(c)}
                style={{ marginTop: "0.5rem", padding: "0.3rem 0.7rem" }}
              >
                Disconnect
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
