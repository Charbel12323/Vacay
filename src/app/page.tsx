import Link from "next/link";

export default function Home() {
  return (
    <main className="hero">
      <div className="eyebrow">Subscription defence</div>
      <h1>
        Know what you pay for.
        <br />
        Cancel what you don&apos;t use.
      </h1>
      <p className="hero-lede">
        SubTracker reads your bank transactions — read-only, it never moves money — finds every
        recurring charge, and flags the ones that got quietly more expensive or slipped your mind.
      </p>
      <div className="hero-actions">
        <Link href="/signup" className="btn btn-primary">
          Create an account
        </Link>
        <Link href="/login">Sign in</Link>
      </div>

      {/* A specimen of the product's core artifact: one ledger row. */}
      <div className="specimen" aria-hidden="true">
        <div className="eyebrow">What it catches</div>
        <div className="ledger-row rail-flare">
          <div>
            <div className="ledger-merchant">Streamio</div>
            <div className="ledger-evidence">Went from $16.99 to $18.99 in May</div>
          </div>
          <span className="ledger-amount">
            $18.99<span className="unit">/mo</span>
          </span>
        </div>
        <div className="ledger-row rail-amber">
          <div>
            <div className="ledger-merchant">FitClub Pro</div>
            <div className="ledger-evidence">Charging since March 2024 — worth a look</div>
          </div>
          <span className="ledger-amount">
            $42.50<span className="unit">/mo</span>
          </span>
        </div>
      </div>

      <p className="hero-fineprint">
        Bank connections via Plaid. Canada-first. Your credentials never touch our servers.
      </p>
    </main>
  );
}
