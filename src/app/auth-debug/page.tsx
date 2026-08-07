"use client";

import { useAuth } from "@/components/auth/AuthProvider";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

export const dynamic = 'force-dynamic';

export default function AuthDebugPage() {
  const { user, isLoading, isAuthenticated, logout } = useAuth();
  const [cookieInfo, setCookieInfo] = useState<string>("");
  const [apiResponse, setApiResponse] = useState<any>(null);
  const [debugLog, setDebugLog] = useState<string[]>([]);

  const addLog = (message: string) => {
    setDebugLog(prev => [...prev, `${new Date().toLocaleTimeString()}: ${message}`]);
  };

  useEffect(() => {
    // Check cookies
    setCookieInfo(document.cookie);
    
    // Test /api/me endpoint
    fetch('/api/me', { credentials: 'include' })
      .then(res => res.json())
      .then(data => {
        setApiResponse(data);
        addLog(`/api/me response: ${JSON.stringify(data)}`);
      })
      .catch(err => {
        setApiResponse({ error: err.message });
        addLog(`/api/me error: ${err.message}`);
      });
  }, []);

  const handleLogout = async () => {
    addLog('Manual logout initiated');
    try {
      await logout();
      addLog('Logout completed');
      // Refresh the page data
      setTimeout(() => {
        window.location.reload();
      }, 1000);
    } catch (error) {
      addLog(`Logout error: ${error}`);
    }
  };

  const clearAllCookies = () => {
    addLog('Clearing all cookies manually');
    // Get all cookies
    const cookies = document.cookie.split(";");
    
    // Clear each cookie
    cookies.forEach(cookie => {
      const eqPos = cookie.indexOf("=");
      const name = eqPos > -1 ? cookie.substr(0, eqPos).trim() : cookie.trim();
      // Clear for current domain and path
      document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/`;
      document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/;domain=${window.location.hostname}`;
    });
    
    addLog('All cookies cleared');
    setTimeout(() => {
      window.location.reload();
    }, 1000);
  };

  return (
    <div className="p-8 max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold mb-6">Authentication Debug</h1>
      
      <div className="space-y-6">
        <div className="bg-gray-100 p-4 rounded">
          <h2 className="font-semibold mb-2">Auth Context State:</h2>
          <p>Loading: {isLoading ? 'Yes' : 'No'}</p>
          <p>Authenticated: {isAuthenticated ? 'Yes' : 'No'}</p>
          <p>User: {user ? JSON.stringify(user, null, 2) : 'null'}</p>
        </div>

        <div className="bg-gray-100 p-4 rounded">
          <h2 className="font-semibold mb-2">Browser Cookies:</h2>
          <pre className="text-sm overflow-x-auto">{cookieInfo || 'No cookies'}</pre>
        </div>

        <div className="bg-gray-100 p-4 rounded">
          <h2 className="font-semibold mb-2">API /me Response:</h2>
          <pre className="text-sm overflow-x-auto">{JSON.stringify(apiResponse, null, 2)}</pre>
        </div>

        <div className="bg-gray-100 p-4 rounded">
          <h2 className="font-semibold mb-2">Debug Actions:</h2>
          <div className="space-x-4">
            <Button onClick={handleLogout} variant="destructive">
              Force Logout
            </Button>
            <Button onClick={clearAllCookies} variant="outline">
              Clear All Cookies
            </Button>
            <Button onClick={() => window.location.href = '/login'} variant="default">
              Go to Login
            </Button>
          </div>
        </div>

        <div className="bg-gray-100 p-4 rounded">
          <h2 className="font-semibold mb-2">Debug Log:</h2>
          <div className="text-sm space-y-1 max-h-40 overflow-y-auto">
            {debugLog.map((log, index) => (
              <div key={index} className="font-mono">{log}</div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}