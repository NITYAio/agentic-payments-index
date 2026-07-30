import type { Metadata } from "next";
import { headers } from "next/headers";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export async function generateMetadata(): Promise<Metadata> {
  const incoming = await headers();
  const host =
    incoming.get("x-forwarded-host") ?? incoming.get("host") ?? "localhost:3000";
  const protocol =
    incoming.get("x-forwarded-proto") ?? (host.includes("localhost") ? "http" : "https");
  const origin = `${protocol}://${host}`;

  return {
    metadataBase: new URL(origin),
    title: "The Agentic Payments Index — Agentic GDP, made legible.",
    description:
      "The open evidence layer for machine-native stablecoin payments across MPP and x402.",
    openGraph: {
      title: "The Agentic Payments Index",
      description:
        "Agentic GDP, made legible. Live MPP and x402 payment intelligence with auditable answers.",
      type: "website",
      images: [
        {
          url: `${origin}/og.png`,
          width: 1733,
          height: 908,
          alt: "The Agentic Payments Index — Agentic GDP, made legible.",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: "The Agentic Payments Index",
      description:
        "Agentic GDP, made legible. Live MPP and x402 payment intelligence with auditable answers.",
      images: [`${origin}/og.png`],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
