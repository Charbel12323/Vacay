import Link from "next/link";
import { googleEnabled, signIn } from "@/lib/auth";
import { LoginForm } from "./login-form";

export default function LoginPage() {
  return (
    <main className="shell-narrow">
      <div className="eyebrow">SubTracker</div>
      <h1 style={{ margin: "0.4rem 0 1.25rem" }}>Sign in</h1>
      <LoginForm />
      {googleEnabled() && (
        <form
          action={async () => {
            "use server";
            await signIn("google", { redirectTo: "/dashboard" });
          }}
          style={{ marginTop: "0.75rem" }}
        >
          <button type="submit" className="btn-quiet" style={{ width: "100%" }}>
            Continue with Google
          </button>
        </form>
      )}
      <p className="muted" style={{ marginTop: "1.5rem" }}>
        No account? <Link href="/signup">Sign up</Link>
      </p>
    </main>
  );
}
