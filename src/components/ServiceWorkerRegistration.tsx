'use client';

import { useEffect, useState } from 'react';
import { register } from '@/lib/serviceWorkerRegistration';

export function ServiceWorkerRegistration() {
  // SSR guard
  if (typeof window === 'undefined') {
    return null;
  }

  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    
    // Always register service worker for PWA functionality
    if (typeof window !== 'undefined') {
      console.log('🔧 [ServiceWorkerRegistration] Attempting to register service worker...');
      console.log('🔧 [ServiceWorkerRegistration] Service Worker API available:', 'serviceWorker' in navigator);
      
      register();
    }
  }, []);

  // Don't render anything during SSR
  if (!mounted) {
    return null;
  }

  return null;
}
