import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { AuthProvider } from "@/components/auth/AuthProvider";
import FirstTimeLoginWrapper from "@/components/auth/FirstTimeLoginWrapper";
import { SurveyCycleProvider } from "@/contexts/SurveyCycleContext";
import { ToastProviderWrapper } from "@/components/providers/ToastProviderWrapper";
import { ServiceWorkerRegistration } from "@/components/ServiceWorkerRegistration";
import { PWAUpdatePrompt } from "@/components/PWAUpdatePrompt";
import { OfflineIndicator } from "@/components/OfflineIndicator";
import "./globals.css";
import "../styles/intro-custom.css";
import "intro.js/introjs.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "PULSE - Public Understanding and Local Service Evaluation",
  description: "A comprehensive survey platform for measuring citizen satisfaction with local government services and improving governance effectiveness.",
  manifest: "/manifest.json",
  icons: {
    icon: [
      { url: '/favicon.ico' },
      { url: '/favicon-16x16.png', sizes: '16x16', type: 'image/png' },
      { url: '/favicon-32x32.png', sizes: '32x32', type: 'image/png' },
      { url: '/android-chrome-192x192.png', sizes: '192x192', type: 'image/png' },
      { url: '/android-chrome-512x512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: [
      { url: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' },
    ],
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "PULSE",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: "#667eea",
};

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
        <ToastProviderWrapper>
          <AuthProvider>
            <SurveyCycleProvider>
              <ServiceWorkerRegistration />
              <PWAUpdatePrompt />
              <OfflineIndicator />
              <FirstTimeLoginWrapper>
                {children}
              </FirstTimeLoginWrapper>
            </SurveyCycleProvider>
          </AuthProvider>
        </ToastProviderWrapper>
      </body>
    </html>
  );
}
