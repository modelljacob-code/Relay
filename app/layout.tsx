import { BackgroundMusic } from "@/app/components/BackgroundMusic";
import { RelayBackground } from "@/app/RelayBackground";
import type { Metadata } from "next";
import { DM_Sans } from "next/font/google";
import "./globals.css";

const dmSans = DM_Sans({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Relay",
  description: "Live turn-based song game",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${dmSans.className} min-h-screen bg-[#4f719f] text-relay-text antialiased`}
      >
        <RelayBackground />
        <BackgroundMusic />
        {children}
      </body>
    </html>
  );
}
