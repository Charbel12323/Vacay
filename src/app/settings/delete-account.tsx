"use client";

import { useState } from "react";
import { signOut } from "next-auth/react";

/**
 * Deletion is real (invariant 9): revokes bank access at Plaid and removes
 * every row. The confirmation asks the user to type DELETE — an account with
 * years of financial history should not die to a stray click.
 */
export function DeleteAccount() {
  const [confirming, setConfirming] = useState(false);
  const [phrase, setPhrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function deleteAccount() {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/users/me", { method: "DELETE" });
    if (!res.ok) {
      setBusy(false);
      setError("Deletion failed. Please try again.");
      return;
    }
    await signOut({ callbackUrl: "/" });
  }

  return (
    <section style={{ marginTop: "2.5rem" }}>
      <h2 style={{ margin: "0 0 0.2rem", fontSize: "1.15rem" }}>Delete account</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        Disconnects every bank at Plaid and permanently removes all of your data — transactions,
        subscriptions, alerts, everything. There is no undo.
      </p>

      {error && <p className="error-text">{error}</p>}

      {!confirming ? (
        <button type="button" className="btn-danger" onClick={() => setConfirming(true)}>
          Delete my account…
        </button>
      ) : (
        <div className="pref-row" style={{ borderColor: "var(--flare)" }}>
          <div style={{ flex: 1 }}>
            <label htmlFor="delete-phrase" style={{ fontSize: "0.875rem" }}>
              Type <strong className="mono">DELETE</strong> to confirm:
            </label>
            <input
              id="delete-phrase"
              className="field mono"
              style={{ marginTop: "0.4rem" }}
              value={phrase}
              onChange={(e) => setPhrase(e.target.value)}
              autoComplete="off"
            />
          </div>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <button
              type="button"
              className="btn-danger"
              disabled={phrase !== "DELETE" || busy}
              onClick={() => void deleteAccount()}
              data-testid="confirm-delete"
            >
              {busy ? "Deleting…" : "Delete everything"}
            </button>
            <button type="button" className="btn-ghost" onClick={() => setConfirming(false)}>
              Keep my account
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
