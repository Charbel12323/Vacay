"use client";

import { useCallback, useEffect, useState } from "react";
import { formatMoney } from "@/lib/money";
import {
  displayName,
  groupByVerdict,
  verdictLine,
  type SubscriptionListItem,
} from "@/lib/verdict-ui";
import { AssistSheet } from "./assist-sheet";

type Summary = {
  monthly_recurring: string;
  currency: string;
  active_count: number;
  flags: { price_increased: number; likely_forgotten: number; probable_annual: number };
  estimated_monthly_waste: string;
  total_saved: string;
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
  const [assistItem, setAssistItem] = useState<SubscriptionListItem | null>(null);
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
    if (assistItem?.id === item.id) setAssistItem(null);
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
    return (
      <p className="muted" style={{ marginTop: "2rem" }}>
        Loading your subscriptions…
      </p>
    );
  }

  const groups = groupByVerdict(items);
  const nothingDetected =
    items.filter((i) => i.status === "active" && i.classification === "subscription").length === 0;

  return (
    <section style={{ marginTop: "2rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <h2 style={{ margin: 0, fontSize: "1.25rem" }}>Subscriptions</h2>
        <span className="mono faint" style={{ fontSize: "0.78rem" }}>
          {minutesAgo(summary.as_of)}
        </span>
      </div>

      {/* The statement header. The monthly total wears the accountant's
          double rule: this is the figure the page exists to defend. */}
      <div className="statement">
        <div className="statement-cell statement-total">
          <div className="statement-label">Monthly recurring</div>
          <div className="statement-figure">
            {formatMoney(summary.monthly_recurring, summary.currency)}
          </div>
          <div className="statement-sub">
            {summary.active_count} active subscription{summary.active_count === 1 ? "" : "s"}
          </div>
          {summary.total_saved !== "0.00" && (
            <div className="statement-saved" data-testid="total-saved">
              Saved {formatMoney(summary.total_saved, summary.currency)}/mo by cancelling
            </div>
          )}
        </div>
        <div className="statement-cell">
          <div className="statement-label">Price increases found</div>
          <div
            className={`statement-figure${summary.flags.price_increased > 0 ? " figure-flare" : ""}`}
          >
            {summary.flags.price_increased}
          </div>
        </div>
        <div className="statement-cell">
          <div className="statement-label">Likely forgotten</div>
          <div
            className={`statement-figure${summary.flags.likely_forgotten > 0 ? " figure-amber" : ""}`}
          >
            {formatMoney(summary.estimated_monthly_waste, summary.currency)}
            <span className="unit">/mo</span>
          </div>
        </div>
      </div>

      {error && <p className="error-text">{error}</p>}

      {nothingDetected ? (
        <p className="empty-note">
          No subscriptions found yet. Once your transactions are analyzed, anything recurring shows
          up here — if you just connected a bank, give it a minute.
        </p>
      ) : (
        <>
          <Group
            title="Price increases"
            rail="rail-flare"
            items={groups.price_increased}
            onOpen={setDetailId}
            onAssist={setAssistItem}
          />
          <Group
            title="Likely forgotten"
            rail="rail-amber"
            items={groups.likely_forgotten}
            onOpen={setDetailId}
            onAssist={setAssistItem}
          />

          {groups.questions.length > 0 && (
            <div className="ledger-section">
              <div className="ledger-heading">
                <h3>Quick questions</h3>
                <span className="ledger-count">{groups.questions.length}</span>
              </div>
              {groups.questions.map((item) => (
                <div key={item.id} className="ledger-row rail-question" data-testid="question-card">
                  <div>
                    <div className="ledger-merchant">{displayName(item)}</div>
                    <div className="ledger-evidence">
                      {verdictLine(item)} ·{" "}
                      <span className="mono">
                        {formatMoney(item.current_amount, item.currency)}
                      </span>
                      {item.cadence ? ` ${cadenceLabel(item.cadence)}` : ""}
                    </div>
                  </div>
                  <div className="ledger-actions">
                    <button
                      type="button"
                      className="btn-primary"
                      onClick={() => void confirmYes(item)}
                    >
                      Yes
                    </button>
                    <button
                      type="button"
                      className="btn-quiet"
                      onClick={() => void patch(item, { user_confirmed: false })}
                    >
                      No
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <Group
            title="Healthy"
            rail="rail-moss"
            items={groups.healthy}
            onOpen={setDetailId}
            onAssist={setAssistItem}
          />
        </>
      )}

      {detail && (
        <DetailDrawer
          detail={detail}
          onClose={() => setDetailId(null)}
          onNotSubscription={() => void patch(detail.subscription, { user_confirmed: false })}
          onDismiss={() => void patch(detail.subscription, { status: "dismissed" })}
          onAssist={() => {
            setAssistItem(detail.subscription);
            setDetailId(null);
          }}
        />
      )}

      {assistItem && (
        <AssistSheet
          subscriptionId={assistItem.id}
          onClose={() => setAssistItem(null)}
          onMarkCancelled={() => void patch(assistItem, { status: "cancelled" })}
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
  rail,
  items,
  onOpen,
  onAssist,
}: {
  title: string;
  rail: string;
  items: SubscriptionListItem[];
  onOpen: (id: string) => void;
  onAssist: (item: SubscriptionListItem) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="ledger-section">
      <div className="ledger-heading">
        <h3>{title}</h3>
        <span className="ledger-count">{items.length}</span>
      </div>
      {items.map((item) => (
        <div key={item.id} className={`ledger-row ${rail}`} data-testid="verdict-row">
          <div>
            <div className="ledger-merchant">{displayName(item)}</div>
            <div className="ledger-evidence">{verdictLine(item)}</div>
          </div>
          <div className="ledger-actions">
            <span className="ledger-amount">
              {formatMoney(item.current_amount, item.currency)}
              <span className="unit">{item.cadence ? cadenceLabel(item.cadence) : ""}</span>
            </span>
            <button type="button" className="btn-ghost" onClick={() => onOpen(item.id)}>
              Details
            </button>
            <button
              type="button"
              className="btn-quiet"
              onClick={() => onAssist(item)}
              data-testid="assist-open"
            >
              Cancel help
            </button>
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
  onAssist,
}: {
  detail: Detail;
  onClose: () => void;
  onNotSubscription: () => void;
  onDismiss: () => void;
  onAssist: () => void;
}) {
  const s = detail.subscription;
  return (
    <div className="drawer" data-testid="detail-drawer">
      <div className="drawer-head">
        <h3>{s.merchant_name ?? displayName(s)}</h3>
        <button type="button" className="btn-ghost" onClick={onClose}>
          Close
        </button>
      </div>
      <p className="muted" style={{ marginTop: "0.35rem" }}>
        {verdictLine(s, detail.price_history[0] ?? null)}
      </p>
      <p>
        <span className="mono">
          {formatMoney(s.current_amount, s.currency)}
          {s.cadence ? cadenceLabel(s.cadence) : ""}
        </span>{" "}
        · confidence <span className="mono">{s.confidence}</span>
        {s.account && (
          <span className="faint">
            {" "}
            · {s.account.name}{" "}
            {s.account.mask ? <span className="mono">••••{s.account.mask}</span> : ""}
          </span>
        )}
      </p>
      {s.next_expected_date && (
        <p>
          Next expected charge: <span className="mono">{s.next_expected_date}</span>
        </p>
      )}

      {detail.price_history.length > 0 && (
        <>
          <h4>Price history</h4>
          <ul className="evidence-list">
            {detail.price_history.map((p, i) => (
              <li key={i}>
                <span className="mono">
                  {formatMoney(p.old_amount, s.currency)} → {formatMoney(p.new_amount, s.currency)}
                </span>
                <span className="mono faint">{p.effective_date}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      <h4>Charges we found</h4>
      <ul className="evidence-list">
        {detail.evidence.map((t) => (
          <li key={t.id}>
            <span>
              <span className="mono faint">{t.date}</span> · <code>{t.raw_descriptor}</code>
            </span>
            <span className="money">{formatMoney(t.amount, t.currency)}</span>
          </li>
        ))}
      </ul>

      <div style={{ display: "flex", gap: "0.5rem", marginTop: "1.25rem", flexWrap: "wrap" }}>
        <button
          type="button"
          className="btn-primary"
          onClick={onAssist}
          data-testid="drawer-assist"
        >
          How to cancel
        </button>
        <button type="button" className="btn-quiet" onClick={onNotSubscription}>
          Not a subscription
        </button>
        <button type="button" className="btn-ghost" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </div>
  );
}
