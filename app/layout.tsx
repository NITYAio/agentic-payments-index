import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const publicOrigin = "https://agenticpaymentsindex.org";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export function generateMetadata(): Metadata {
  return {
    metadataBase: new URL(publicOrigin),
    title: "The Agentic Payments Index — The machine economy, made legible.",
    description:
      "The open evidence layer for machine-native stablecoin payments across MPP and x402.",
    alternates: {
      canonical: "/",
    },
    robots: {
      index: false,
      follow: false,
      nocache: true,
      googleBot: {
        index: false,
        follow: false,
        noimageindex: true,
      },
    },
    openGraph: {
      title: "The Agentic Payments Index",
      description:
        "The machine economy, made legible. Live MPP and x402 payment intelligence with auditable answers.",
      type: "website",
      url: publicOrigin,
      images: [
        {
          url: `${publicOrigin}/og-v5.png`,
          width: 1200,
          height: 630,
          alt: "The Agentic Payments Index — The machine economy, made legible.",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: "The Agentic Payments Index",
      description:
        "The machine economy, made legible. Live MPP and x402 payment intelligence with auditable answers.",
      images: [`${publicOrigin}/og-v5.png`],
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
