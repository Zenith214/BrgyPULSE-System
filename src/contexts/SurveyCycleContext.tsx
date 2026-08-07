"use client";

import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { SurveyCycle } from '@/utils/surveyCycleHelpers';

interface SurveyCycleContextType {
  activeCycle: SurveyCycle | null;
  allCycles: SurveyCycle[];
  loading: boolean;
  error: string | null;
  refreshActiveCycle: () => Promise<void>;
  refreshAllCycles: () => Promise<void>;
  setActiveCycle: (cycleId: number) => Promise<void>;
}

const SurveyCycleContext = createContext<SurveyCycleContextType | undefined>(undefined);

export function useSurveyCycle() {
  const context = useContext(SurveyCycleContext);
  if (context === undefined) {
    throw new Error('useSurveyCycle must be used within a SurveyCycleProvider');
  }
  return context;
}

interface SurveyCycleProviderProps {
  children: React.ReactNode;
}

export function SurveyCycleProvider({ children }: SurveyCycleProviderProps) {
  // Safety check for SSR/build time
  if (typeof window === 'undefined') {
    return (
      <SurveyCycleContext.Provider value={{
        activeCycle: null,
        allCycles: [],
        loading: true,
        error: null,
        refreshActiveCycle: async () => {},
        refreshAllCycles: async () => {},
        setActiveCycle: async () => {},
      }}>
        {children}
      </SurveyCycleContext.Provider>
    );
  }

  const [activeCycle, setActiveCycleState] = useState<SurveyCycle | null>(null);
  const [allCycles, setAllCycles] = useState<SurveyCycle[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refreshActiveCycle = useCallback(async () => {
    try {
      setError(null);
      const response = await fetch('/api/survey-cycles/active');
      
      if (response.ok) {
        const data = await response.json();
        setActiveCycleState(data.data);
      } else if (response.status === 404) {
        // No active cycle found - this is a valid state
        setActiveCycleState(null);
      } else if (response.status === 401) {
        // User not authenticated - clear state silently
        setActiveCycleState(null);
        setError(null);
        return;
      } else {
        const errorData = await response.json();
        throw new Error(errorData.message || 'Failed to fetch active cycle');
      }
    } catch (error) {
      // Only log errors if it's not a network/auth issue
      if (error instanceof Error && !error.message.includes('fetch')) {
        console.error('Failed to refresh active cycle:', error);
        setError(error.message);
      }
      setActiveCycleState(null);
    }
  }, []);

  const refreshAllCycles = useCallback(async () => {
    try {
      setError(null);
      const response = await fetch('/api/survey-cycles');
      
      if (response.ok) {
        const data = await response.json();
        setAllCycles(data.data || []);
      } else if (response.status === 401) {
        // User not authenticated - clear state silently
        setAllCycles([]);
        setError(null);
        return;
      } else {
        const errorData = await response.json();
        throw new Error(errorData.message || 'Failed to fetch cycles');
      }
    } catch (error) {
      // Only log errors if it's not a network/auth issue
      if (error instanceof Error && !error.message.includes('fetch')) {
        console.error('Failed to refresh all cycles:', error);
        setError(error.message);
      }
      setAllCycles([]);
    }
  }, []);

  const setActiveCycle = useCallback(async (cycleId: number) => {
    try {
      setError(null);
      setLoading(true);
      
      const response = await fetch('/api/survey-cycles/active', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ cycle_id: cycleId }),
      });

      if (response.ok) {
        const data = await response.json();
        setActiveCycleState(data.data);
        // Refresh all cycles to update their active status
        await refreshAllCycles();
      } else {
        const errorData = await response.json();
        throw new Error(errorData.message || 'Failed to set active cycle');
      }
    } catch (error) {
      console.error('Failed to set active cycle:', error);
      setError(error instanceof Error ? error.message : 'Failed to set active cycle');
      throw error; // Re-throw so the UI can handle it
    } finally {
      setLoading(false);
    }
  }, [refreshAllCycles]);

  // Initial data loading
  useEffect(() => {
    const loadInitialData = async () => {
      setLoading(true);
      try {
        // Load both active cycle and all cycles in parallel
        await Promise.all([
          refreshActiveCycle(),
          refreshAllCycles()
        ]);
      } catch (error) {
        console.error('Failed to load initial survey cycle data:', error);
      } finally {
        setLoading(false);
      }
    };

    loadInitialData();
  }, [refreshActiveCycle, refreshAllCycles]);

  const value = {
    activeCycle,
    allCycles,
    loading,
    error,
    refreshActiveCycle,
    refreshAllCycles,
    setActiveCycle,
  };

  return (
    <SurveyCycleContext.Provider value={value}>
      {children}
    </SurveyCycleContext.Provider>
  );
}