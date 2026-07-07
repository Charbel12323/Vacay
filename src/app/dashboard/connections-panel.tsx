"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
  pending: "Preparing…",
  syncing: "Analyzing your accounts…",
  ready: "Up to date",
  ok: "Up to date",
  reauth_required: "Needs re-authentication",
  degraded: "Having trouble syncing",
  revoking: "Disconnecting…",
};

const IN_PROGRESS = new Set(["pending", "syncing", "revoking"]);

export function ConnectionsPanel() {
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [reauthState, setReauthState] = useState<{ id: string; token: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const res = await fetch("/api/connections");
    if (res.ok) {
      const body = await res.json();
      setConnections(body.connections);
      return body.connections as Connection[];
    }
    return null;
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

  // Poll while any connection is mid-sync ("Analyzing your accounts…").
  const anyInProgress = connections?.some((c) => IN_PROGRESS.has(c.status)) ?? false;
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (anyInProgress && !pollRef.current) {
      pollRef.current = setInterval(() => void refresh(), 2500);
    }
    if (!anyInProgress && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [anyInProgress, refresh]);

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

  async function manualRefresh(connection: Connection) {
    setError(null);
    const res = await fetch(`/api/connections/${connection.id}/refresh`, { method: "POST" });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setError(body?.error?.message ?? "Refresh failed.");
      return;
    }
    await refresh();
  }

  async function startReauth(connection: Connection) {
    setError(null);
    const res = await fetch(`/api/connections/${connection.id}/reauth`, { method: "POST" });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setError(body?.error?.message ?? "Could not start re-authentication.");
      return;
    }
    const body = await res.json();
    setReauthState({ id: connection.id, token: body.link_token });
  }

  async function onReauthSuccess(connectionId: string) {
    setReauthState(null);
    await fetch(`/api/connections/${connectionId}/reauth`, { method: "PATCH" });
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

      {reauthState && (
        <ReauthLink
          token={reauthState.token}
          onSuccess={() => void onReauthSuccess(reauthState.id)}
          onExit={() => setReauthState(null)}
        />
      )}

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

              {c.status === "reauth_required" && (
                <div
                  style={{
                    background: "#fff4e5",
                    border: "1px solid #f0c36d",
                    borderRadius: 6,
                    padding: "0.6rem",
                    marginTop: "0.5rem",
                  }}
                >
                  This bank needs you to sign in again to keep syncing.{" "}
                  <button type="button" onClick={() => void startReauth(c)}>
                    Reconnect
                  </button>
                </div>
              )}

              <ul style={{ listStyle: "none", padding: 0, marginTop: "0.5rem", color: "#444" }}>
                {c.accounts.map((a) => (
                  <li key={a.id}>
                    {a.name} {a.mask ? `••••${a.mask}` : ""} · {a.type} · {a.currency}
                  </li>
                ))}
              </ul>
              <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem" }}>
                <button
                  type="button"
                  onClick={() => void manualRefresh(c)}
                  disabled={IN_PROGRESS.has(c.status)}
                  style={{ padding: "0.3rem 0.7rem" }}
                >
                  Refresh
                </button>
                <button
                  type="button"
                  onClick={() => void disconnect(c)}
                  style={{ padding: "0.3rem 0.7rem" }}
                >
                  Disconnect
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Opens Plaid Link in update mode as soon as its token is ready. */
function ReauthLink({
  token,
  onSuccess,
  onExit,
}: {
  token: string;
  onSuccess: () => void;
  onExit: () => void;
}) {
  const { open, ready } = usePlaidLink({ token, onSuccess, onExit });
  useEffect(() => {
    if (ready) open();
  }, [ready, open]);
  return null;
}
