import Link from "next/link";
import { googleEnabled, signIn } from "@/lib/auth";
import { SignupForm } from "./signup-form";

export default function SignupPage() {
  return (
    <main className="shell-narrow">
      <div className="eyebrow">SubTracker</div>
      <h1 style={{ margin: "0.4rem 0 0.35rem" }}>Create an account</h1>
      <p className="muted" style={{ margin: "0 0 1.25rem" }}>
        Read-only bank access. SubTracker never moves money.
      </p>
      <SignupForm />
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
        Already have an account? <Link href="/login">Sign in</Link>
      </p>
    </main>
  );
}
