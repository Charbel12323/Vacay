import pino from "pino";

/**
 * Structured logger with redaction (Stage 9 tasks 8 and 10). Anything
 * credential- or PII-shaped is censored at the logger, so a sloppy call site
 * cannot leak a token into log storage. Plaid payloads and raw descriptors
 * must never be logged wholesale — log ids and counts, not bodies.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: {
    paths: [
      "password",
      "*.password",
      "access_token",
      "*.access_token",
      "accessToken",
      "*.accessToken",
      "accessTokenEnc",
      "*.accessTokenEnc",
      "authorization",
      "*.authorization",
      "cookie",
      "*.cookie",
      "email",
      "*.email",
      "raw_descriptor",
      "*.raw_descriptor",
      "rawDescriptor",
      "*.rawDescriptor",
    ],
    censor: "[redacted]",
  },
  base: undefined, // no pid/hostname noise locally; the platform adds its own
});

/** Child logger for one subsystem, e.g. workerLog("sync"). */
export function subsystem(name: string) {
  return logger.child({ subsystem: name });
}
