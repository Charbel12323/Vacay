import Link from "next/link";

export default function Home() {
  return (
    <main
      style={{ fontFamily: "system-ui, sans-serif", padding: "4rem 2rem", textAlign: "center" }}
    >
      <h1>SubTracker</h1>
      <p>Subscription defense for your bank accounts.</p>
      <p style={{ marginTop: "2rem" }}>
        <Link href="/login">Sign in</Link>
        {" · "}
        <Link href="/signup">Create an account</Link>
      </p>
    </main>
  );
}
