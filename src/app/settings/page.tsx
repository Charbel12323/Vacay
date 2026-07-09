import Link from "next/link";
import { PreferencesForm } from "./preferences-form";

export default function SettingsPage() {
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", maxWidth: 560, margin: "3rem auto" }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1>Settings</h1>
        <Link href="/dashboard">Back to dashboard</Link>
      </header>

      <section style={{ marginTop: "1.5rem" }}>
        <h2 style={{ marginBottom: "0.25rem" }}>Email alerts</h2>
        <p style={{ color: "#666", marginTop: 0 }}>
          Everything always appears in your in-app feed; these switches only control email.
        </p>
        <PreferencesForm />
        <p style={{ color: "#888", fontSize: "0.85rem", marginTop: "1rem" }}>
          Bank reconnection emails cannot be turned off — without them a broken connection would
          fail silently and you would stop seeing new charges.
        </p>
      </section>
    </main>
  );
}
