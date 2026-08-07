"use client";

import { createContext, useContext, useEffect, useState } from 'react';
import { User, getCurrentUser, login, logout, LoginCredentials } from '@/lib/auth';
import { useInactivityTimeout } from '@/hooks/useInactivityTimeout';

interface AuthContextType {
  user: User | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  login: (credentials: LoginCredentials) => Promise<{ success: boolean; error?: string; role?: string }>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  isLoading: true,
  isAuthenticated: false,
  login: async () => ({ success: false }),
  logout: async () => {},
  refreshUser: async () => {},
});

export function useAuth() {
  return useContext(AuthContext);
}

interface AuthProviderProps {
  children: React.ReactNode;
}

export function AuthProvider({ children }: AuthProviderProps) {
  // Safety check for SSR/build time
  if (typeof window === 'undefined') {
    return (
      <AuthContext.Provider value={{
        user: null,
        isLoading: true,
        isAuthenticated: false,
        login: async () => ({ success: false }),
        logout: async () => {},
        refreshUser: async () => {},
      }}>
        {children}
      </AuthContext.Provider>
    );
  }

  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Setup inactivity timeout - only active when user is authenticated
  useInactivityTimeout({
    timeoutMinutes: 10,
    enabled: !!user,
    onTimeout: () => {
      console.log('User logged out due to inactivity');
      setUser(null);
    },
  });

  const refreshUser = async () => {
    try {
      const currentUser = await getCurrentUser();
      setUser(currentUser);
    } catch (error) {
      console.error('Failed to refresh user:', error);
      setUser(null);
    }
  };

  const handleLogin = async (credentials: LoginCredentials) => {
    const result = await login(credentials);
    if (result.success) {
      console.log('AuthProvider: Login successful, refreshing user data');
      // Refresh user data after successful login with retry logic
      let retries = 3;
      while (retries > 0) {
        try {
          await refreshUser();
          if (user) {
            console.log('AuthProvider: User data refreshed successfully');
            break; // Successfully got user data
          }
        } catch (error) {
          console.warn('Retry getting user data:', error);
        }
        retries--;
        if (retries > 0) {
          await new Promise(resolve => setTimeout(resolve, 200)); // Wait 200ms before retry
        }
      }
    }
    return result;
  };

  const handleLogout = async () => {
    await logout();
    setUser(null);
  };

  useEffect(() => {
    // Check authentication status on mount
    const checkAuth = async () => {
      try {
        setIsLoading(true);
        const currentUser = await getCurrentUser();
        console.log('AuthProvider: Initial auth check result:', currentUser ? `${currentUser.email} (${currentUser.role})` : 'No user');
        setUser(currentUser);
      } catch (error) {
        console.error('Auth check failed:', error);
        setUser(null);
      } finally {
        setIsLoading(false);
      }
    };

    checkAuth();
  }, []);

  const value = {
    user,
    isLoading,
    isAuthenticated: !!user,
    login: handleLogin,
    logout: handleLogout,
    refreshUser,
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}