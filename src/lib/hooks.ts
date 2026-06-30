import { useState, useEffect } from 'react';
import { useStore } from '@/store/useStore';

/**
 * Mock Auth Hook to demonstrate security/auth handling
 */
export const useAuth = () => {
  const { isLoggedIn, username } = useStore();
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    // Simulate checking session/token
    const timer = setTimeout(() => {
      setIsLoading(false);
    }, 500);
    return () => clearTimeout(timer);
  }, []);

  return {
    isAuthenticated: isLoggedIn,
    user: username,
    isLoading
  };
};
