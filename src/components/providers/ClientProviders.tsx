'use client';

import dynamic from 'next/dynamic';
import { ReactNode } from 'react';

// Dynamically import all client components with SSR disabled
const ToastProviderWrapper = dynamic(
  () => import('./ToastProviderWrapper').then(mod => mod.ToastProviderWrapper),
  { ssr: false }
);

const AuthProvider = dynamic(
  () => import('../auth/AuthProvider').then(mod => ({ default: mod.AuthProvider })),
  { ssr: false }
);

const SurveyCycleProvider = dynamic(
  () => import('../../contexts/SurveyCycleContext').then(mod => ({ default: mod.SurveyCycleProvider })),
  { ssr: false }
);

const ServiceWorkerRegistration = dynamic(
  () => import('../ServiceWorkerRegistration').then(mod => ({ default: mod.ServiceWorkerRegistration })),
  { ssr: false }
);

const PWAUpdatePrompt = dynamic(
  () => import('../PWAUpdatePrompt').then(mod => ({ default: mod.PWAUpdatePrompt })),
  { ssr: false }
);

const OfflineIndicator = dynamic(
  () => import('../OfflineIndicator').then(mod => ({ default: mod.OfflineIndicator })),
  { ssr: false }
);

const FirstTimeLoginWrapper = dynamic(
  () => import('../auth/FirstTimeLoginWrapper'),
  { ssr: false }
);

interface ClientProvidersProps {
  children: ReactNode;
}

export function ClientProviders({ children }: ClientProvidersProps) {
  return (
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
  );
}
