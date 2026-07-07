import { auth, signOut } from "@/lib/auth";

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
      <p style={{ color: "#666" }}>
        Nothing here yet — connect a bank in an upcoming release to see your subscriptions.
      </p>
    </main>
  );
}
