import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: {
    default: "JFK",
    template: "%s · JFK",
  },
  description: "Contribute, decide and build together.",
  applicationName: "JFK",
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "JFK" },
};

export const viewport: Viewport = {
  themeColor: "#0b0b10",
  // Wallet-style app: the layout is designed for the viewport, not for zooming.
  // `maximumScale` is deliberately left alone so pinch-zoom still works.
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col">
        <div aria-hidden="true" className="ambient" />
        {children}
      </body>
    </html>
  );
}
