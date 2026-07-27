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
    title: "Blockscope — Machine Payments Intelligence",
    description:
      "Explore live MPP network activity and ask plain-English questions about machine payment volume, agents, services, and transaction size.",
    openGraph: {
      title: "Blockscope — The machine economy, answered.",
      description:
        "Live MPP payment intelligence with auditable, plain-English answers.",
      type: "website",
      images: [
        {
          url: `${origin}/og.png`,
          width: 1732,
          height: 908,
          alt: "Blockscope — The machine economy, answered.",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: "Blockscope — The machine economy, answered.",
      description:
        "Live MPP payment intelligence with auditable, plain-English answers.",
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
