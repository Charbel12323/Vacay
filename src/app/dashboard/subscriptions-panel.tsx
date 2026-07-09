"use client";

import { useCallback, useEffect, useState } from "react";
import { formatMoney } from "@/lib/money";
import {
  displayName,
  groupByVerdict,
  verdictLine,
  type SubscriptionListItem,
} from "@/lib/verdict-ui";

type Summary = {
  monthly_recurring: string;
  currency: string;
  active_count: number;
  flags: { price_increased: number; likely_forgotten: number; probable_annual: number };
  estimated_monthly_waste: string;
  as_of: string | null;
};

type Detail = {
  subscription: SubscriptionListItem & {
    merchant_name: string | null;
    last_charge_date: string | null;
    account: { name: string; mask: string | null } | null;
  };
  price_history: Array<{ old_amount: string; new_amount: string; effective_date: string }>;
  evidence: Array<{
    id: string;
    date: string;
    amount: string;
    currency: string;
    raw_descriptor: string;
    pending: boolean;
  }>;
};

const card: React.CSSProperties = {
  border: "1px solid #ddd",
  borderRadius: 8,
  padding: "1rem",
  flex: 1,
};
const row: React.CSSProperties = {
  border: "1px solid #eee",
  borderRadius: 8,
  padding: "0.75rem 1rem",
  marginTop: "0.5rem",
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: "1rem",
};

function minutesAgo(iso: string | null): string {
  if (!iso) return "not synced yet";
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 1) return "updated just now";
  if (mins === 1) return "updated 1 min ago";
  if (mins < 120) return `updated ${mins} min ago`;
  return `updated ${Math.round(mins / 60)} h ago`;
}

export function SubscriptionsPanel() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [items, setItems] = useState<SubscriptionListItem[] | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [sRes, lRes] = await Promise.all([
      fetch("/api/subscriptions/summary"),
      fetch("/api/subscriptions?status=active"),
    ]);
    if (sRes.ok) setSummary(await sRes.json());
    if (lRes.ok) setItems((await lRes.json()).subscriptions);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!detailId) {
      setDetail(null);
      return;
    }
    void (async () => {
      const res = await fetch(`/api/subscriptions/${detailId}`);
      if (res.ok) setDetail(await res.json());
    })();
  }, [detailId]);

  /** Optimistic PATCH; on error revert + surface (never fake success). */
  async function patch(item: SubscriptionListItem, body: Record<string, unknown>) {
    const before = items;
    setItems((prev) => prev?.filter((i) => i.id !== item.id) ?? null);
    setError(null);
    const res = await fetch(`/api/subscriptions/${item.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      setItems(before);
      const payload = await res.json().catch(() => null);
      setError(payload?.error?.message ?? "That didn't save. Please try again.");
      return;
    }
    if (detailId === item.id) setDetailId(null);
    await refresh();
  }

  async function confirmYes(item: SubscriptionListItem) {
    setError(null);
    const res = await fetch(`/api/subscriptions/${item.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_confirmed: true }),
    });
    if (!res.ok) {
      setError("That didn't save. Please try again.");
      return;
    }
    await refresh();
  }

  if (items === null || summary === null) {
    return <p style={{ color: "#666", marginTop: "2rem" }}>Loading your subscriptions…</p>;
  }

  const groups = groupByVerdict(items);
  const nothingDetected =
    items.filter((i) => i.status === "active" && i.classification === "subscription").length === 0;

  return (
    <section style={{ marginTop: "2rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <h2 style={{ margin: 0 }}>Subscriptions</h2>
        <span style={{ color: "#888", fontSize: "0.85rem" }}>{minutesAgo(summary.as_of)}</span>
      </div>

      <div style={{ display: "flex", gap: "1rem", marginTop: "1rem" }}>
        <div style={card}>
          <div style={{ color: "#666", fontSize: "0.85rem" }}>Monthly recurring</div>
          <div style={{ fontSize: "1.6rem", fontWeight: 600 }}>
            {formatMoney(summary.monthly_recurring, summary.currency)}
          </div>
          <div style={{ color: "#888", fontSize: "0.8rem" }}>
            {summary.active_count} active subscription{summary.active_count === 1 ? "" : "s"}
          </div>
        </div>
        <div style={card}>
          <div style={{ color: "#666", fontSize: "0.85rem" }}>Price increases found</div>
          <div style={{ fontSize: "1.6rem", fontWeight: 600 }}>{summary.flags.price_increased}</div>
        </div>
        <div style={card}>
          <div style={{ color: "#666", fontSize: "0.85rem" }}>Likely forgotten</div>
          <div style={{ fontSize: "1.6rem", fontWeight: 600 }}>
            {formatMoney(summary.estimated_monthly_waste, summary.currency)}
            <span style={{ fontSize: "0.85rem", color: "#888" }}> /mo</span>
          </div>
        </div>
      </div>

      {error && <p style={{ color: "crimson" }}>{error}</p>}

      {nothingDetected ? (
        <p style={{ color: "#666", marginTop: "1.5rem" }}>
          No subscriptions found yet. Once your transactions are analyzed, anything recurring shows
          up here — if you just connected a bank, give it a minute.
        </p>
      ) : (
        <>
          <Group title="Price increases" items={groups.price_increased} onOpen={setDetailId} />
          <Group title="Likely forgotten" items={groups.likely_forgotten} onOpen={setDetailId} />

          {groups.questions.length > 0 && (
            <div style={{ marginTop: "1.5rem" }}>
              <h3 style={{ marginBottom: 0 }}>Quick questions</h3>
              {groups.questions.map((item) => (
                <div key={item.id} style={row} data-testid="question-card">
                  <div>
                    <strong>{displayName(item)}</strong>
                    <div style={{ color: "#666", fontSize: "0.9rem" }}>
                      {verdictLine(item)} · {formatMoney(item.current_amount, item.currency)}
                      {item.cadence ? ` ${cadenceLabel(item.cadence)}` : ""}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: "0.5rem" }}>
                    <button type="button" onClick={() => void confirmYes(item)}>
                      Yes
                    </button>
                    <button
                      type="button"
                      onClick={() => void patch(item, { user_confirmed: false })}
                    >
                      No
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <Group title="Healthy" items={groups.healthy} onOpen={setDetailId} />
        </>
      )}

      {detail && (
        <DetailDrawer
          detail={detail}
          onClose={() => setDetailId(null)}
          onNotSubscription={() => void patch(detail.subscription, { user_confirmed: false })}
          onDismiss={() => void patch(detail.subscription, { status: "dismissed" })}
        />
      )}
    </section>
  );
}

function cadenceLabel(cadence: string): string {
  return (
    {
      weekly: "/wk",
      biweekly: "/2wk",
      monthly: "/mo",
      bimonthly: "/2mo",
      quarterly: "/qtr",
      annual: "/yr",
    }[cadence] ?? ""
  );
}

function Group({
  title,
  items,
  onOpen,
}: {
  title: string;
  items: SubscriptionListItem[];
  onOpen: (id: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div style={{ marginTop: "1.5rem" }}>
      <h3 style={{ marginBottom: 0 }}>{title}</h3>
      {items.map((item) => (
        <div key={item.id} style={row} data-testid="verdict-row">
          <div>
            <strong>{displayName(item)}</strong>
            <div style={{ color: "#666", fontSize: "0.9rem" }}>{verdictLine(item)}</div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
            <span style={{ fontWeight: 600 }}>
              {formatMoney(item.current_amount, item.currency)}
              <span style={{ color: "#888", fontWeight: 400 }}>
                {item.cadence ? cadenceLabel(item.cadence) : ""}
              </span>
            </span>
            <button type="button" onClick={() => onOpen(item.id)}>
              Details
            </button>
            {/* Action button placeholder — Stage 8 wires cancellation assist. */}
          </div>
        </div>
      ))}
    </div>
  );
}

function DetailDrawer({
  detail,
  onClose,
  onNotSubscription,
  onDismiss,
}: {
  detail: Detail;
  onClose: () => void;
  onNotSubscription: () => void;
  onDismiss: () => void;
}) {
  const s = detail.subscription;
  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        right: 0,
        bottom: 0,
        width: "min(420px, 90vw)",
        background: "#fff",
        borderLeft: "1px solid #ddd",
        boxShadow: "-4px 0 16px rgba(0,0,0,0.08)",
        padding: "1.25rem",
        overflowY: "auto",
        zIndex: 50,
      }}
      data-testid="detail-drawer"
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h3 style={{ margin: 0 }}>{s.merchant_name ?? displayName(s)}</h3>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
      <p style={{ color: "#666" }}>{verdictLine(s, detail.price_history[0] ?? null)}</p>
      <p>
        {formatMoney(s.current_amount, s.currency)}
        {s.cadence ? ` ${cadenceLabel(s.cadence)}` : ""} · confidence {s.confidence}
        {s.account && (
          <span style={{ color: "#888" }}>
            {" "}
            · {s.account.name} {s.account.mask ? `••••${s.account.mask}` : ""}
          </span>
        )}
      </p>
      {s.next_expected_date && <p>Next expected charge: {s.next_expected_date}</p>}

      {detail.price_history.length > 0 && (
        <>
          <h4>Price history</h4>
          <ul style={{ paddingLeft: "1rem" }}>
            {detail.price_history.map((p, i) => (
              <li key={i}>
                {formatMoney(p.old_amount, s.currency)} → {formatMoney(p.new_amount, s.currency)} on{" "}
                {p.effective_date}
              </li>
            ))}
          </ul>
        </>
      )}

      <h4>Charges we found</h4>
      <ul style={{ listStyle: "none", padding: 0 }}>
        {detail.evidence.map((t) => (
          <li
            key={t.id}
            style={{
              display: "flex",
              justifyContent: "space-between",
              borderBottom: "1px solid #f0f0f0",
              padding: "0.35rem 0",
              fontSize: "0.9rem",
            }}
          >
            <span style={{ color: "#555" }}>
              {t.date} · <code>{t.raw_descriptor}</code>
            </span>
            <span>{formatMoney(t.amount, t.currency)}</span>
          </li>
        ))}
      </ul>

      <div style={{ display: "flex", gap: "0.5rem", marginTop: "1rem" }}>
        <button type="button" onClick={onNotSubscription}>
          Not a subscription
        </button>
        <button type="button" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </div>
  );
}
