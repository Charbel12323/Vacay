import {
  Body,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Link,
  Preview,
  Section,
  Text,
  render,
} from "@react-email/components";
import { formatMoney } from "@/lib/money";
import type { AlertType } from "./create";

/**
 * Alert email templates (Stage 7 task 3). Copy rules: calm, factual,
 * evidence-first — "we noticed", never "you wasted". Every email links to the
 * dashboard and to the preferences page. NEVER include raw bank descriptors
 * or account numbers beyond the mask (snapshot tests enforce this).
 */

export type AlertEmailContext = {
  type: AlertType;
  payload: Record<string, unknown>;
  merchantName: string | null;
  amount: string | null;
  currency: string;
  cadence: string | null;
  accountMask: string | null;
  institutionName: string | null;
  baseUrl: string;
};

export type RenderedEmail = { subject: string; html: string };

export async function renderAlertEmail(ctx: AlertEmailContext): Promise<RenderedEmail> {
  const subject = subjectFor(ctx);
  const html = await render(<AlertEmail ctx={ctx} subject={subject} />);
  return { subject, html };
}

function subjectFor(ctx: AlertEmailContext): string {
  const merchant = ctx.merchantName ?? "A subscription";
  const p = ctx.payload;
  switch (ctx.type) {
    case "price_increase":
      return `${merchant} went from ${money(String(p.old_amount), ctx)} to ${money(String(p.new_amount), ctx)}`;
    case "renewal_upcoming":
      return `${merchant} looks set to renew on ${String(p.expected_date)}`;
    case "upcoming_charge":
      return `${merchant} will charge ${ctx.amount ? money(ctx.amount, ctx) : "soon"} around ${String(p.expected_date)}`;
    case "reauth_required":
      return `${ctx.institutionName ?? "One of your banks"} needs a quick reconnection`;
    case "charged_after_cancellation":
      return `${merchant} charged you after cancellation`;
  }
}

function money(amount: string, ctx: AlertEmailContext): string {
  return formatMoney(amount, ctx.currency);
}

function AlertEmail({ ctx, subject }: { ctx: AlertEmailContext; subject: string }) {
  return (
    <Html lang="en">
      <Head>
        <style>{darkModeCss}</style>
      </Head>
      <Preview>{subject}</Preview>
      <Body className="st-body" style={styles.body}>
        <Container className="st-card" style={styles.card}>
          <Text className="st-muted" style={styles.brand}>
            SubTracker
          </Text>
          <AlertBody ctx={ctx} />
          <Section style={{ marginTop: 24 }}>
            <Link href={ctxLink(ctx)} style={styles.button}>
              {ctx.type === "reauth_required" ? "Reconnect your bank" : "See the details"}
            </Link>
          </Section>
          <Hr className="st-hr" style={styles.hr} />
          <Text className="st-muted" style={styles.footer}>
            You are getting this because SubTracker watches your subscriptions for changes that
            matter. Choose which emails you get on the{" "}
            <Link href={`${ctx.baseUrl}/settings`} style={styles.link}>
              preferences page
            </Link>
            . SubTracker reads transactions to help you decide — it never moves money.
          </Text>
        </Container>
      </Body>
    </Html>
  );
}

function ctxLink(ctx: AlertEmailContext): string {
  return `${ctx.baseUrl}/dashboard`;
}

function AlertBody({ ctx }: { ctx: AlertEmailContext }) {
  const merchant = ctx.merchantName ?? "One of your subscriptions";
  const p = ctx.payload;
  const onAccount = ctx.accountMask ? ` on your account ending ${ctx.accountMask}` : "";

  switch (ctx.type) {
    case "price_increase":
      return (
        <>
          <Heading as="h2" style={styles.heading}>
            {merchant} costs more than it used to
          </Heading>
          <Text style={styles.text}>
            We noticed the recurring {merchant} charge{onAccount} went from{" "}
            <strong>{money(String(p.old_amount), ctx)}</strong> to{" "}
            <strong>{money(String(p.new_amount), ctx)}</strong>
            {typeof p.effective_date === "string" ? ` starting ${p.effective_date}` : ""}. That is
            all we know — the price simply changed.
          </Text>
          <Text className="st-muted" style={styles.textMuted}>
            If the new price still feels worth it, there is nothing to do.
          </Text>
        </>
      );
    case "renewal_upcoming":
      return (
        <>
          <Heading as="h2" style={styles.heading}>
            {merchant} looks set to renew soon
          </Heading>
          <Text style={styles.text}>
            Based on its charge history, {merchant}
            {onAccount} should renew around <strong>{String(p.expected_date)}</strong>
            {ctx.amount ? (
              <>
                {" "}
                for about <strong>{money(ctx.amount, ctx)}</strong>
              </>
            ) : null}
            . Annual charges are easy to forget — this is the moment to decide, not after the charge
            lands.
          </Text>
        </>
      );
    case "upcoming_charge":
      return (
        <>
          <Heading as="h2" style={styles.heading}>
            A {merchant} charge is coming up
          </Heading>
          <Text style={styles.text}>
            {merchant}
            {onAccount} usually charges{" "}
            {ctx.amount ? <strong>{money(ctx.amount, ctx)}</strong> : "around this time"} and the
            next one should land near <strong>{String(p.expected_date)}</strong>.
          </Text>
        </>
      );
    case "reauth_required":
      return (
        <>
          <Heading as="h2" style={styles.heading}>
            {ctx.institutionName ?? "One of your banks"} stopped syncing
          </Heading>
          <Text style={styles.text}>
            Banks periodically ask you to sign in again before they keep sharing data. Until you
            reconnect, SubTracker cannot see new charges — renewals and price changes could slip by
            unnoticed.
          </Text>
        </>
      );
    case "charged_after_cancellation":
      return (
        <>
          <Heading as="h2" style={styles.heading}>
            {merchant} charged you after cancellation
          </Heading>
          <Text style={styles.text}>
            A new {merchant} charge{onAccount} arrived after this subscription was marked cancelled.
            Worth a look — mistaken charges are usually refundable when caught early.
          </Text>
        </>
      );
  }
}

const styles = {
  body: {
    backgroundColor: "#f5f5f4",
    color: "#1c1917",
    fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif",
    padding: "24px 12px",
  },
  card: {
    backgroundColor: "#ffffff",
    border: "1px solid #e7e5e4",
    borderRadius: 8,
    maxWidth: 520,
    padding: "28px 32px",
  },
  brand: { color: "#78716c", fontSize: 13, letterSpacing: 1, margin: 0 },
  heading: { fontSize: 20, margin: "14px 0 4px" },
  text: { fontSize: 15, lineHeight: "23px" },
  textMuted: { color: "#78716c", fontSize: 14, lineHeight: "21px" },
  button: {
    backgroundColor: "#1c1917",
    borderRadius: 6,
    color: "#ffffff",
    display: "inline-block",
    fontSize: 14,
    padding: "10px 18px",
    textDecoration: "none",
  },
  link: { color: "#2563eb" },
  hr: { borderColor: "#e7e5e4", margin: "28px 0 12px" },
  footer: { color: "#78716c", fontSize: 12, lineHeight: "18px" },
} as const;

/** Dark-client support: class-based overrides beat the inline light styles. */
const darkModeCss = `
  @media (prefers-color-scheme: dark) {
    .st-body { background-color: #121212 !important; color: #e7e5e4 !important; }
    .st-card { background-color: #1c1a19 !important; border-color: #35322f !important; }
    .st-card h2, .st-card p { color: #e7e5e4 !important; }
    .st-muted, .st-card .st-muted { color: #a8a29e !important; }
    .st-hr { border-color: #35322f !important; }
  }
`;
