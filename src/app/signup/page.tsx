import Link from "next/link";
import { googleEnabled, signIn } from "@/lib/auth";
import { SignupForm } from "./signup-form";

export default function SignupPage() {
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", maxWidth: 360, margin: "4rem auto" }}>
      <h1>Create an account</h1>
      <SignupForm />
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
        Already have an account? <Link href="/login">Sign in</Link>
      </p>
    </main>
  );
}
