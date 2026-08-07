"use client";

import { useState, useEffect } from "react";
import { useAuth } from "./AuthProvider";
import FirstTimePasswordChangeModal from "./FirstTimePasswordChangeModal";
import OnboardingTour from "./OnboardingTour";

interface FirstTimeLoginWrapperProps {
  children: React.ReactNode;
}

export default function FirstTimeLoginWrapper({ children }: FirstTimeLoginWrapperProps) {
  // Always call hooks - Rules of Hooks
  const { user, refreshUser } = useAuth();
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [startTour, setStartTour] = useState(false);
  const [hasChecked, setHasChecked] = useState(false);

  useEffect(() => {
    // Skip on SSR
    if (typeof window === 'undefined') return;
    
    // Check if user is first-time login
    if (user && !hasChecked) {
      setHasChecked(true);
      
      // Check if user has firstLogin flag set to true AND is on dashboard
      if ((user as any).firstLogin === true && window.location.pathname === '/dashboard') {
        setShowPasswordModal(true);
      } else {
        // Check if tour should be shown
        const tourCompleted = localStorage.getItem('onboardingTourCompleted');
        if (!tourCompleted && window.location.pathname === '/dashboard') {
          // Small delay to ensure page is fully loaded
          setTimeout(() => setStartTour(true), 1000);
        }
      }
    }
  }, [user, hasChecked]);

  const handlePasswordChangeSuccess = async () => {
    setShowPasswordModal(false);
    
    // Refresh user data to get updated firstLogin status
    await refreshUser();
    
    // Start tour after password change if on dashboard
    const tourCompleted = localStorage.getItem('onboardingTourCompleted');
    if (!tourCompleted && window.location.pathname === '/dashboard') {
      setTimeout(() => setStartTour(true), 1000);
    }
  };

  const handleTourComplete = () => {
    setStartTour(false);
    localStorage.setItem('onboardingTourCompleted', 'true');
  };

  return (
    <>
      {children}
      <FirstTimePasswordChangeModal
        isOpen={showPasswordModal}
        onSuccess={handlePasswordChangeSuccess}
      />
      <OnboardingTour
        shouldStart={startTour}
        onComplete={handleTourComplete}
      />
    </>
  );
}
