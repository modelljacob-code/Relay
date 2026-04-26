import { BackgroundMusic } from "@/app/components/BackgroundMusic";
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
      <body className={`${dmSans.className} min-h-screen`}>
        <BackgroundMusic />
        {children}
      </body>
    </html>
  );
}
