'use client';

import { useState, useEffect } from 'react';

/**
 * Custom hook to detect online/offline status
 * Returns true when online, false when offline
 */
export function useOnlineStatus() {
  // SSR guard - default to online during build
  const [isOnline, setIsOnline] = useState(typeof window === 'undefined' ? true : navigator.onLine);

  useEffect(() => {
    // Set initial status
    if (typeof window !== 'undefined') {
      setIsOnline(navigator.onLine);
    }

    // Handle online event
    const handleOnline = () => {
      console.log('[Network] Connection restored');
      setIsOnline(true);
    };

    // Handle offline event
    const handleOffline = () => {
      console.log('[Network] Connection lost');
      setIsOnline(false);
    };

    // Add event listeners
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    // Cleanup
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  return isOnline;
}
