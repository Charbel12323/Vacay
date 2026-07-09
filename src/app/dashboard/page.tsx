import Link from "next/link";
import { auth, signOut } from "@/lib/auth";
import { AlertsBell } from "./alerts-bell";
import { ConnectionsPanel } from "./connections-panel";
import { SubscriptionsPanel } from "./subscriptions-panel";

export default async function DashboardPage() {
  const session = await auth();

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", maxWidth: 720, margin: "3rem auto" }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1>Dashboard</h1>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <AlertsBell />
          <Link href="/settings" style={{ padding: "0.4rem 0.4rem", fontSize: "0.9rem" }}>
            Settings
          </Link>
          <form
            action={async () => {
              "use server";
              await signOut({ redirectTo: "/" });
            }}
          >
            <button type="submit" style={{ padding: "0.4rem 0.8rem" }}>
              Sign out
            </button>
          </form>
        </div>
      </header>
      <p>Signed in as {session?.user?.email}.</p>
      <SubscriptionsPanel />
      <ConnectionsPanel />
    </main>
  );
}
