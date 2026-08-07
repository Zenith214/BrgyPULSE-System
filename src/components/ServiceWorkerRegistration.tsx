'use client';

import { useEffect, useState } from 'react';
import { register } from '@/lib/serviceWorkerRegistration';

export function ServiceWorkerRegistration() {
  // Always call hooks - Rules of Hooks
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    // Skip on SSR
    if (typeof window === 'undefined') return;
    
    setMounted(true);
    
    // Always register service worker for PWA functionality
    console.log('🔧 [ServiceWorkerRegistration] Attempting to register service worker...');
    console.log('🔧 [ServiceWorkerRegistration] Service Worker API available:', 'serviceWorker' in navigator);
    
    register();
  }, []);

  // Don't render anything during SSR or before mount
  if (!mounted) {
    return null;
  }

  return null;
}
