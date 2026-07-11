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
    <div className="drawer" data-testid="assist-sheet" style={{ zIndex: 60 }}>
      {failed ? (
        <>
          <p className="error-text">Could not load cancellation help. Please try again.</p>
          <button type="button" className="btn-quiet" onClick={onClose}>
            Close
          </button>
        </>
      ) : assist === null ? (
        <p className="muted">Loading cancellation help…</p>
      ) : (
        <>
          <div className="drawer-head">
            <h3>Cancel {assist.merchant}</h3>
            <button type="button" className="btn-ghost" onClick={onClose}>
              Close
            </button>
          </div>
          <p className="muted" style={{ marginTop: "0.35rem", fontSize: "0.875rem" }}>
            {DIFFICULTY_LABELS[assist.difficulty] ?? ""}
            {!assist.had_data && " · generic guidance — we don't have verified steps yet"}
          </p>

          <ol className="steps-list">
            {assist.steps.map((step, i) => (
              <li key={i}>
                <label>
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
                  <span className={checked.has(i) ? "step-done" : undefined}>{step}</span>
                </label>
              </li>
            ))}
          </ol>

          {assist.notes && <p className="note-box">{assist.notes}</p>}

          <div style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap", marginTop: "0.9rem" }}>
            {assist.url && (
              <a
                href={assist.url}
                target="_blank"
                rel="noreferrer"
                className="btn btn-primary"
                data-testid="assist-deep-link"
              >
                Open {assist.merchant} account settings ↗
              </a>
            )}
            {assist.email && (
              <a href={`mailto:${assist.email}`} className="mono" style={{ fontSize: "0.85rem" }}>
                {assist.email}
              </a>
            )}
            {assist.phone && (
              <a href={`tel:${assist.phone}`} className="mono" style={{ fontSize: "0.85rem" }}>
                {assist.phone}
              </a>
            )}
          </div>

          {assist.draft && (
            <div style={{ marginTop: "1.4rem" }}>
              <h4>Message you can send</h4>
              <p className="muted" style={{ fontSize: "0.82rem", margin: "0 0 0.45rem" }}>
                {assist.draft.subject} — edit anything before you copy it.
              </p>
              <textarea
                value={draftBody}
                onChange={(e) => setDraftBody(e.target.value)}
                rows={10}
                className="draft-box"
                data-testid="assist-draft"
              />
              <button
                type="button"
                className="btn-quiet"
                style={{ marginTop: "0.45rem" }}
                onClick={() => void copyDraft()}
              >
                {copied ? "Copied ✓" : "Copy message"}
              </button>
            </div>
          )}

          <hr className="hr" />
          <p className="muted" style={{ fontSize: "0.875rem" }}>
            Done? Marking it cancelled moves its cost into your savings, and we&apos;ll flag any
            charge that still shows up afterwards.
          </p>
          <button
            type="button"
            className="btn-primary"
            onClick={onMarkCancelled}
            data-testid="mark-cancelled"
          >
            Mark as cancelled
          </button>
        </>
      )}
    </div>
  );
}
