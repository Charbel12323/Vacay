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
    <div ref={panelRef} className="bell-wrap">
      <button
        type="button"
        aria-label={`Alerts (${unread} unread)`}
        data-testid="alerts-bell"
        className="bell-btn"
        onClick={() => setOpen((o) => !o)}
      >
        🔔
        {unread > 0 && (
          <span data-testid="unread-badge" className="bell-badge">
            {unread}
          </span>
        )}
      </button>

      {open && (
        <div data-testid="alerts-panel" className="bell-panel">
          <h3>Alerts</h3>
          {error && <p className="error-text">{error}</p>}
          {items === null ? (
            <p className="muted">Loading…</p>
          ) : items.length === 0 ? (
            <p className="muted">
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
                    className="alert-item"
                    onClick={() => void markRead(alert)}
                  >
                    {alertTitle(alert)}
                    <span className="alert-date">
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
              className="btn-ghost"
              style={{ marginTop: "0.5rem" }}
              onClick={() => void load(nextCursor)}
            >
              Load more
            </button>
          )}
        </div>
      )}
    </div>
  );
}
