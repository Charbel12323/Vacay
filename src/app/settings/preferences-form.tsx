"use client";

import { useEffect, useState } from "react";

type Preference = {
  type: "price_increase" | "renewal_upcoming" | "upcoming_charge" | "charged_after_cancellation";
  email_enabled: boolean;
  is_default: boolean;
};

const LABELS: Record<Preference["type"], { title: string; hint: string }> = {
  price_increase: {
    title: "Price increases",
    hint: "A subscription starts charging more than it used to.",
  },
  renewal_upcoming: {
    title: "Renewals coming up",
    hint: "An annual or quarterly plan renews within 30 days.",
  },
  upcoming_charge: {
    title: "Upcoming charges",
    hint: "A charge lands within 3 days. Off by default for monthly plans — noisy.",
  },
  charged_after_cancellation: {
    title: "Charges after cancellation",
    hint: "A cancelled subscription charges you anyway.",
  },
};

/** Toggles save immediately; failures revert and surface (never fake success). */
export function PreferencesForm() {
  const [prefs, setPrefs] = useState<Preference[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const res = await fetch("/api/alerts/preferences");
      if (res.ok) setPrefs((await res.json()).preferences);
      else setError("Could not load your preferences.");
    })();
  }, []);

  async function toggle(pref: Preference) {
    setError(null);
    const nextValue = !pref.email_enabled;
    setPrefs(
      (prev) =>
        prev?.map((p) =>
          p.type === pref.type ? { ...p, email_enabled: nextValue, is_default: false } : p,
        ) ?? null,
    );
    const res = await fetch("/api/alerts/preferences", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: pref.type, email_enabled: nextValue }),
    });
    if (!res.ok) {
      setPrefs((prev) => prev?.map((p) => (p.type === pref.type ? pref : p)) ?? null);
      setError("That didn't save. Please try again.");
      return;
    }
    setPrefs((await res.json()).preferences);
  }

  if (prefs === null && !error) return <p className="muted">Loading…</p>;

  return (
    <div>
      {error && <p className="error-text">{error}</p>}
      <ul className="pref-list">
        {prefs?.map((pref) => (
          <li key={pref.type} className="pref-row">
            <div>
              <strong>{LABELS[pref.type].title}</strong>
              <div className="pref-hint">{LABELS[pref.type].hint}</div>
            </div>
            <label className="pref-toggle">
              <input
                type="checkbox"
                data-testid={`pref-${pref.type}`}
                checked={pref.email_enabled}
                onChange={() => void toggle(pref)}
              />
              <span>{pref.email_enabled ? "Email on" : "Email off"}</span>
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
}
