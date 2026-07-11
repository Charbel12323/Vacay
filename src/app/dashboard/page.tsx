import Link from "next/link";
import { auth, signOut } from "@/lib/auth";
import { AlertsBell } from "./alerts-bell";
import { ConnectionsPanel } from "./connections-panel";
import { SubscriptionsPanel } from "./subscriptions-panel";

export default async function DashboardPage() {
  const session = await auth();

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <div className="eyebrow">SubTracker</div>
          <h1>Dashboard</h1>
        </div>
        <div className="topbar-actions">
          <AlertsBell />
          <Link href="/settings" className="btn btn-ghost">
            Settings
          </Link>
          <form
            action={async () => {
              "use server";
              await signOut({ redirectTo: "/" });
            }}
          >
            <button type="submit" className="btn-quiet">
              Sign out
            </button>
          </form>
        </div>
      </header>
      <p className="signed-in">Signed in as {session?.user?.email}.</p>
      <SubscriptionsPanel />
      <ConnectionsPanel />
    </main>
  );
}
