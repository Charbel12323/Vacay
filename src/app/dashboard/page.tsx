import { auth, signOut } from "@/lib/auth";
import { ConnectionsPanel } from "./connections-panel";

export default async function DashboardPage() {
  const session = await auth();

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", maxWidth: 720, margin: "3rem auto" }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1>Dashboard</h1>
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
      </header>
      <p>Signed in as {session?.user?.email}.</p>
      <ConnectionsPanel />
    </main>
  );
}
