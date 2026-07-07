import Link from "next/link";
import { googleEnabled, signIn } from "@/lib/auth";
import { LoginForm } from "./login-form";

export default function LoginPage() {
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", maxWidth: 360, margin: "4rem auto" }}>
      <h1>Sign in</h1>
      <LoginForm />
      {googleEnabled() && (
        <form
          action={async () => {
            "use server";
            await signIn("google", { redirectTo: "/dashboard" });
          }}
          style={{ marginTop: "1rem" }}
        >
          <button type="submit" style={{ width: "100%", padding: "0.5rem" }}>
            Continue with Google
          </button>
        </form>
      )}
      <p style={{ marginTop: "1.5rem" }}>
        No account? <Link href="/signup">Sign up</Link>
      </p>
    </main>
  );
}
