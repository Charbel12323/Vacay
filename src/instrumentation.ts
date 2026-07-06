/**
 * Next.js instrumentation hook: runs once when the server boots.
 * Validating env here means the web app refuses to start with missing keys.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { env } = await import("./lib/env");
    env();
  }
}
