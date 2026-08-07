'use client';

import { useEffect, useState } from 'react';
import { useOnlineStatus } from '@/hooks/useOnlineStatus';
import { WifiOff, Wifi } from 'lucide-react';

/**
 * OfflineIndicator Component
 * Displays a banner when the user is offline and a notification when back online
 */
export function OfflineIndicator() {
  // Always call hooks - Rules of Hooks
  const isOnline = useOnlineStatus();
  const [showOnlineNotification, setShowOnlineNotification] = useState(false);
  const [wasOffline, setWasOffline] = useState(false);

  useEffect(() => {
    if (!isOnline) {
      setWasOffline(true);
      setShowOnlineNotification(false);
    } else if (wasOffline && isOnline) {
      // Show "back online" notification
      setShowOnlineNotification(true);
      
      // Hide notification after 3 seconds
      const timer = setTimeout(() => {
        setShowOnlineNotification(false);
        setWasOffline(false);
      }, 3000);
      
      return () => clearTimeout(timer);
    }
  }, [isOnline, wasOffline]);

  return (
    <>
      {/* Offline Banner */}
      {!isOnline && (
        <div className="fixed top-0 left-0 right-0 z-50 bg-amber-500 text-white px-4 py-3 shadow-lg">
          <div className="flex items-center justify-center gap-2">
            <WifiOff className="h-5 w-5" />
            <span className="font-medium">Working offline</span>
            <span className="text-sm opacity-90">
              - Your data will sync when connection is restored
            </span>
          </div>
        </div>
      )}

      {/* Back Online Notification */}
      {showOnlineNotification && (
        <div className="fixed top-4 right-4 z-50 bg-green-500 text-white px-6 py-3 rounded-lg shadow-lg animate-in slide-in-from-top-5 duration-300">
          <div className="flex items-center gap-2">
            <Wifi className="h-5 w-5" />
            <span className="font-medium">Back online</span>
          </div>
        </div>
      )}
    </>
  );
}
