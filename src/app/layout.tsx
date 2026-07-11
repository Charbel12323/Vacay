import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Bricolage_Grotesque, Public_Sans, Spline_Sans_Mono } from "next/font/google";
import "./globals.css";

// Display face: character without losing trustworthiness.
const bricolage = Bricolage_Grotesque({
  subsets: ["latin"],
  variable: "--font-bricolage",
});

// Body face: designed for civic clarity — the right register for bank data.
const publicSans = Public_Sans({
  subsets: ["latin"],
  variable: "--font-public",
});

// The ledger column: every amount, date, and mask renders in this.
const splineMono = Spline_Sans_Mono({
  subsets: ["latin"],
  variable: "--font-spline-mono",
});

export const metadata: Metadata = {
  title: "SubTracker",
  description: "Know what you pay for. Cancel what you don't use.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      className={`${bricolage.variable} ${publicSans.variable} ${splineMono.variable}`}
    >
      <body>{children}</body>
    </html>
  );
}
