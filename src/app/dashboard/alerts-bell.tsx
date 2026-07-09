"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { alertTitle, type FeedAlert } from "@/lib/alert-ui";

type FeedResponse = {
  alerts: FeedAlert[];
  unread_count: number;
  next_cursor: string | null;
};

/**
 * Bell + alert feed panel. Marking read is optimistic with revert-on-error
 * (never fake success), matching the subscriptions panel's behavior.
 */
export function AlertsBell() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<FeedAlert[] | null>(null);
  const [unread, setUnread] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async (cursor?: string) => {
    const res = await fetch(
      cursor ? `/api/alerts?cursor=${encodeURIComponent(cursor)}` : "/api/alerts",
    );
    if (!res.ok) return;
    const body: FeedResponse = await res.json();
    setItems((prev) => (cursor && prev ? [...prev, ...body.alerts] : body.alerts));
    setUnread(body.unread_count);
    setNextCursor(body.next_cursor);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [open]);

  async function markRead(alert: FeedAlert) {
    if (alert.read) return;
    setError(null);
    setItems((prev) => prev?.map((a) => (a.id === alert.id ? { ...a, read: true } : a)) ?? null);
    setUnread((u) => Math.max(0, u - 1));
    const res = await fetch(`/api/alerts/${alert.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ read: true }),
    });
    if (!res.ok) {
      setItems((prev) => prev?.map((a) => (a.id === alert.id ? { ...a, read: false } : a)) ?? null);
      setUnread((u) => u + 1);
      setError("That didn't save. Please try again.");
    }
  }

  return (
    <div ref={panelRef} style={{ position: "relative" }}>
      <button
        type="button"
        aria-label={`Alerts (${unread} unread)`}
        data-testid="alerts-bell"
        onClick={() => setOpen((o) => !o)}
        style={{ padding: "0.4rem 0.8rem", position: "relative" }}
      >
        🔔
        {unread > 0 && (
          <span
            data-testid="unread-badge"
            style={{
              position: "absolute",
              top: -6,
              right: -6,
              background: "crimson",
              color: "#fff",
              borderRadius: 999,
              fontSize: "0.7rem",
              padding: "0.1rem 0.4rem",
            }}
          >
            {unread}
          </span>
        )}
      </button>

      {open && (
        <div
          data-testid="alerts-panel"
          style={{
            position: "absolute",
            right: 0,
            top: "2.6rem",
            width: "min(380px, 90vw)",
            maxHeight: 420,
            overflowY: "auto",
            background: "#fff",
            border: "1px solid #ddd",
            borderRadius: 8,
            boxShadow: "0 4px 16px rgba(0,0,0,0.08)",
            padding: "0.75rem",
            zIndex: 40,
          }}
        >
          <h3 style={{ margin: "0 0 0.5rem" }}>Alerts</h3>
          {error && <p style={{ color: "crimson", fontSize: "0.85rem" }}>{error}</p>}
          {items === null ? (
            <p style={{ color: "#666" }}>Loading…</p>
          ) : items.length === 0 ? (
            <p style={{ color: "#666" }}>
              Nothing yet. When a price changes or a renewal approaches, it shows up here.
            </p>
          ) : (
            <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {items.map((alert) => (
                <li key={alert.id}>
                  <button
                    type="button"
                    data-testid="alert-item"
                    data-read={alert.read}
                    onClick={() => void markRead(alert)}
                    style={{
                      display: "block",
                      width: "100%",
                      textAlign: "left",
                      background: "none",
                      border: "none",
                      borderBottom: "1px solid #f0f0f0",
                      padding: "0.5rem 0.25rem",
                      cursor: alert.read ? "default" : "pointer",
                      fontWeight: alert.read ? 400 : 600,
                      color: "inherit",
                      fontSize: "0.9rem",
                    }}
                  >
                    {alertTitle(alert)}
                    <span
                      style={{
                        display: "block",
                        color: "#888",
                        fontWeight: 400,
                        fontSize: "0.75rem",
                      }}
                    >
                      {new Date(alert.created_at).toLocaleDateString()}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {nextCursor && (
            <button
              type="button"
              onClick={() => void load(nextCursor)}
              style={{ marginTop: "0.5rem", padding: "0.3rem 0.7rem" }}
            >
              Load more
            </button>
          )}
        </div>
      )}
    </div>
  );
}
