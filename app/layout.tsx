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
    title: "Blockscope — Stablecoin Payments Intelligence",
    description:
      "Compare observed MPP and x402 stablecoin payments, explore services, and ask plain-English questions about protocol activity.",
    openGraph: {
      title: "Blockscope — Agent payments, made legible.",
      description:
        "Live MPP and x402 payment intelligence with auditable answers.",
      type: "website",
      images: [
        {
          url: `${origin}/og-v2.png`,
          width: 1733,
          height: 908,
          alt: "Blockscope — Agent payments, made legible.",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: "Blockscope — Agent payments, made legible.",
      description:
        "Live MPP and x402 payment intelligence with auditable answers.",
      images: [`${origin}/og-v2.png`],
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
