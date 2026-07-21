import Link from "next/link";

/**
 * PIPEDA-oriented privacy page (Stage 9 task 9). Plain language on purpose:
 * consent copy has to be understandable to count as consent.
 */
export default function PrivacyPage() {
  return (
    <main className="shell" style={{ maxWidth: 640 }}>
      <div className="eyebrow">SubTracker</div>
      <h1>Privacy</h1>
      <p className="muted">
        The short version: we read transactions to find your subscriptions, we never move money, and
        when you delete your account everything actually gets deleted.
      </p>

      <h2 style={{ fontSize: "1.1rem", marginTop: "1.75rem" }}>What we collect</h2>
      <ul>
        <li>Your email and, if you give one, your name — to run your account.</li>
        <li>
          Bank transaction data (dates, amounts, merchant descriptions) and account names with their
          last-4 masks, provided by Plaid with your consent when you connect a bank.
        </li>
        <li>
          We never see or store your bank username or password — those go directly to Plaid, and our
          access is read-only. We cannot move money, and neither can anyone who compromises us.
        </li>
      </ul>

      <h2 style={{ fontSize: "1.1rem", marginTop: "1.5rem" }}>What we use it for</h2>
      <ul>
        <li>Detecting recurring charges, price increases, and forgotten subscriptions.</li>
        <li>Alerting you — in-app and, if you keep them on, by email.</li>
        <li>
          Nothing else. No ads, no selling data, no profiling beyond your own dashboard. Assist
          usage is counted per merchant with no link to you.
        </li>
      </ul>

      <h2 style={{ fontSize: "1.1rem", marginTop: "1.5rem" }}>Deletion and retention</h2>
      <ul>
        <li>
          Deleting your account (Settings → Delete account) revokes our bank access at Plaid and
          purges every row of your data — immediately in normal operation, and always within 30 days
          even if systems misbehave.
        </li>
        <li>
          Bank access tokens are stored encrypted; transaction data lives only in our database.
        </li>
      </ul>

      <p className="muted" style={{ marginTop: "1.75rem" }}>
        Questions or access requests: privacy@subtracker.app. You can also read this before
        connecting — the connect screen links here for a reason.
      </p>

      <p style={{ marginTop: "1.5rem" }}>
        <Link href="/">Back to SubTracker</Link>
      </p>
    </main>
  );
}
