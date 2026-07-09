"use client";

import { useEffect, useState } from "react";

type Draft = { template_id: string; subject: string; body: string };

type Assist = {
  merchant: string;
  had_data: boolean;
  method: "web" | "email" | "phone" | "chat" | "unknown";
  url?: string;
  email?: string;
  phone?: string;
  steps: string[];
  difficulty: number;
  notes?: string;
  draft: Draft | null;
};

const DIFFICULTY_LABELS: Record<number, string> = {
  1: "Quick — a couple of clicks",
  2: "Takes a few minutes",
  3: "They make you work for it",
};

/**
 * Cancellation assist sheet (Stage 8): steps checklist, deep link, editable
 * drafted message, and the "Mark as cancelled" outcome action. Instructions
 * and drafts only — nothing here automates against merchant sites.
 */
export function AssistSheet({
  subscriptionId,
  onClose,
  onMarkCancelled,
}: {
  subscriptionId: string;
  onClose: () => void;
  onMarkCancelled: () => void;
}) {
  const [assist, setAssist] = useState<Assist | null>(null);
  const [failed, setFailed] = useState(false);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [draftBody, setDraftBody] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void (async () => {
      const res = await fetch(`/api/subscriptions/${subscriptionId}/cancellation`);
      if (!res.ok) {
        setFailed(true);
        return;
      }
      const body = await res.json();
      setAssist(body.assist);
      setDraftBody(body.assist.draft?.body ?? "");
    })();
  }, [subscriptionId]);

  async function copyDraft() {
    await navigator.clipboard.writeText(draftBody);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        right: 0,
        bottom: 0,
        width: "min(440px, 92vw)",
        background: "#fff",
        borderLeft: "1px solid #ddd",
        boxShadow: "-4px 0 16px rgba(0,0,0,0.08)",
        padding: "1.25rem",
        overflowY: "auto",
        zIndex: 60,
      }}
      data-testid="assist-sheet"
    >
      {failed ? (
        <>
          <p style={{ color: "crimson" }}>Could not load cancellation help. Please try again.</p>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </>
      ) : assist === null ? (
        <p style={{ color: "#666" }}>Loading cancellation help…</p>
      ) : (
        <>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <h3 style={{ margin: 0 }}>Cancel {assist.merchant}</h3>
            <button type="button" onClick={onClose}>
              Close
            </button>
          </div>
          <p style={{ color: "#666", fontSize: "0.9rem" }}>
            {DIFFICULTY_LABELS[assist.difficulty] ?? ""}
            {!assist.had_data && " · generic guidance — we don't have verified steps yet"}
          </p>

          <ol style={{ paddingLeft: "1.25rem" }}>
            {assist.steps.map((step, i) => (
              <li key={i} style={{ margin: "0.5rem 0" }}>
                <label style={{ display: "flex", gap: "0.5rem", alignItems: "flex-start" }}>
                  <input
                    type="checkbox"
                    checked={checked.has(i)}
                    onChange={() =>
                      setChecked((prev) => {
                        const next = new Set(prev);
                        if (next.has(i)) next.delete(i);
                        else next.add(i);
                        return next;
                      })
                    }
                  />
                  <span
                    style={{
                      color: checked.has(i) ? "#999" : "inherit",
                      textDecoration: checked.has(i) ? "line-through" : "none",
                    }}
                  >
                    {step}
                  </span>
                </label>
              </li>
            ))}
          </ol>

          {assist.notes && (
            <p
              style={{
                background: "#fff8e6",
                border: "1px solid #f0dfa8",
                borderRadius: 6,
                padding: "0.6rem",
                fontSize: "0.9rem",
              }}
            >
              {assist.notes}
            </p>
          )}

          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginTop: "0.5rem" }}>
            {assist.url && (
              <a
                href={assist.url}
                target="_blank"
                rel="noreferrer"
                style={{
                  background: "#1c1917",
                  color: "#fff",
                  borderRadius: 6,
                  padding: "0.5rem 0.9rem",
                  textDecoration: "none",
                  fontSize: "0.9rem",
                }}
                data-testid="assist-deep-link"
              >
                Open {assist.merchant} account settings ↗
              </a>
            )}
            {assist.email && <a href={`mailto:${assist.email}`}>{assist.email}</a>}
            {assist.phone && <a href={`tel:${assist.phone}`}>{assist.phone}</a>}
          </div>

          {assist.draft && (
            <div style={{ marginTop: "1.25rem" }}>
              <h4 style={{ marginBottom: "0.25rem" }}>Message you can send</h4>
              <p style={{ color: "#666", fontSize: "0.85rem", marginTop: 0 }}>
                {assist.draft.subject} — edit anything before you copy it.
              </p>
              <textarea
                value={draftBody}
                onChange={(e) => setDraftBody(e.target.value)}
                rows={10}
                style={{
                  width: "100%",
                  fontFamily: "inherit",
                  fontSize: "0.9rem",
                  padding: "0.5rem",
                  border: "1px solid #ddd",
                  borderRadius: 6,
                }}
                data-testid="assist-draft"
              />
              <button type="button" onClick={() => void copyDraft()}>
                {copied ? "Copied ✓" : "Copy message"}
              </button>
            </div>
          )}

          <hr style={{ margin: "1.25rem 0", border: "none", borderTop: "1px solid #eee" }} />
          <p style={{ color: "#666", fontSize: "0.9rem" }}>
            Done? Marking it cancelled moves its cost into your savings, and we&apos;ll flag any
            charge that still shows up afterwards.
          </p>
          <button
            type="button"
            onClick={onMarkCancelled}
            style={{ padding: "0.5rem 0.9rem" }}
            data-testid="mark-cancelled"
          >
            Mark as cancelled
          </button>
        </>
      )}
    </div>
  );
}
