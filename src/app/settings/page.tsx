import Link from "next/link";
import { DeleteAccount } from "./delete-account";
import { PreferencesForm } from "./preferences-form";

export default function SettingsPage() {
  return (
    <main className="shell" style={{ maxWidth: 620 }}>
      <header className="topbar">
        <div>
          <div className="eyebrow">SubTracker</div>
          <h1>Settings</h1>
        </div>
        <Link href="/dashboard" className="btn btn-ghost">
          Back to dashboard
        </Link>
      </header>

      <section style={{ marginTop: "1.75rem" }}>
        <h2 style={{ margin: "0 0 0.2rem", fontSize: "1.15rem" }}>Email alerts</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          Everything always appears in your in-app feed; these switches only control email.
        </p>
        <PreferencesForm />
        <p className="faint" style={{ fontSize: "0.82rem", marginTop: "1rem" }}>
          Bank reconnection emails cannot be turned off — without them a broken connection would
          fail silently and you would stop seeing new charges.
        </p>
      </section>

      <DeleteAccount />
    </main>
  );
}
