import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
  type User,
} from 'firebase/auth';
import { FIREBASE_ENABLED, firebaseAuth } from '../lib/firebase';

interface AuthContextType {
  user: User | null;
  loading: boolean;
  isAuthEnabled: boolean;
  isAdmin: boolean;
  adminEmails: string[];
  signIn: (email: string, password: string) => Promise<{ error: string | null }>;
  signUp: (email: string, password: string) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
  getIdToken: () => Promise<string | null>;
}

const AuthContext = createContext<AuthContextType | null>(null);

const normalizeEmail = (email?: string | null) => (email || '').trim().toLowerCase();

function parseAdminEmails() {
  return String(import.meta.env.VITE_ADMIN_EMAILS || '')
    .split(',')
    .map((email) => normalizeEmail(email))
    .filter(Boolean);
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(FIREBASE_ENABLED);
  const adminEmails = useMemo(parseAdminEmails, []);

  useEffect(() => {
    if (!firebaseAuth) {
      setLoading(false);
      return;
    }
    return onAuthStateChanged(firebaseAuth, (nextUser) => {
      setUser(nextUser);
      setLoading(false);
    });
  }, []);

  const isAdmin = Boolean(user?.email && adminEmails.includes(normalizeEmail(user.email)));

  const signIn = async (email: string, password: string) => {
    if (!firebaseAuth) return { error: 'Firebase is not configured for this deployment.' };
    try {
      await signInWithEmailAndPassword(firebaseAuth, email, password);
      return { error: null };
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Sign in failed.' };
    }
  };

  const signUp = async (email: string, password: string) => {
    if (!firebaseAuth) return { error: 'Firebase is not configured for this deployment.' };
    try {
      await createUserWithEmailAndPassword(firebaseAuth, email, password);
      return { error: null };
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Sign up failed.' };
    }
  };

  const signOut = async () => {
    if (firebaseAuth) await firebaseSignOut(firebaseAuth);
  };

  const getIdToken = async () => {
    if (!firebaseAuth?.currentUser) return null;
    return firebaseAuth.currentUser.getIdToken();
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        isAuthEnabled: FIREBASE_ENABLED,
        isAdmin,
        adminEmails,
        signIn,
        signUp,
        signOut,
        getIdToken,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
