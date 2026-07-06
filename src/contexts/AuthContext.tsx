import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { signInWithPopup, signInWithEmailAndPassword, signOut, onAuthStateChanged, type User } from 'firebase/auth';
import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore';
import { auth, db, googleProvider, ADMIN_EMAILS, MAX_PROMPTS_PER_USER } from '../config/firebase';

interface AuthUser {
  uid: string;
  email: string;
  displayName: string;
  photoURL: string | null;
  isAdmin: boolean;
  promptsUsed: number;
  /** v1.6.1 (Phase 3) — this account's allotment (admin-granted per contract;
   *  falls back to the global default when unset). */
  maxPrompts: number;
  promptsRemaining: number;
}

interface AuthContextType {
  user: AuthUser | null;
  loading: boolean;
  signInWithGoogle: () => Promise<void>;
  signInWithEmail: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  consumePrompt: () => Promise<boolean>; // returns false if limit reached
  refreshPromptCount: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function useAuth(): AuthContextType {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  const buildAuthUser = useCallback(async (firebaseUser: User): Promise<AuthUser> => {
    const email = firebaseUser.email || '';
    const isAdmin = ADMIN_EMAILS.includes(email.toLowerCase());

    // Fetch or create user doc in Firestore
    const userRef = doc(db, 'users', firebaseUser.uid);
    const userSnap = await getDoc(userRef);

    let promptsUsed = 0;
    let maxPrompts = MAX_PROMPTS_PER_USER;
    if (userSnap.exists()) {
      promptsUsed = userSnap.data().promptsUsed || 0;
      // v1.6.1 — per-customer allotment (admin-granted; Firestore rules stop
      // a user from writing this field themselves)
      const mp = userSnap.data().maxPrompts;
      if (typeof mp === 'number' && Number.isFinite(mp) && mp >= 0) maxPrompts = mp;
      // Update last login
      await setDoc(userRef, { lastLogin: serverTimestamp() }, { merge: true });
    } else {
      // First login — create user doc
      await setDoc(userRef, {
        email,
        displayName: firebaseUser.displayName || '',
        photoURL: firebaseUser.photoURL || null,
        promptsUsed: 0,
        isAdmin,
        createdAt: serverTimestamp(),
        lastLogin: serverTimestamp(),
      });
    }

    return {
      uid: firebaseUser.uid,
      email,
      displayName: firebaseUser.displayName || '',
      photoURL: firebaseUser.photoURL || null,
      isAdmin,
      promptsUsed,
      maxPrompts,
      promptsRemaining: isAdmin ? Infinity : Math.max(0, maxPrompts - promptsUsed),
    };
  }, []);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      if (firebaseUser) {
        try {
          const authUser = await buildAuthUser(firebaseUser);
          setUser(authUser);
        } catch (err) {
          console.error('Error building auth user:', err);
          setUser(null);
        }
      } else {
        setUser(null);
      }
      setLoading(false);
    });
    return () => unsubscribe();
  }, [buildAuthUser]);

  const signInWithGoogle = useCallback(async () => {
    try {
      const result = await signInWithPopup(auth, googleProvider);
      const authUser = await buildAuthUser(result.user);
      setUser(authUser);
    } catch (err: any) {
      console.error('Google sign-in error:', err);
      throw err;
    }
  }, [buildAuthUser]);

  const signInWithEmail = useCallback(async (email: string, password: string) => {
    try {
      const result = await signInWithEmailAndPassword(auth, email, password);
      const authUser = await buildAuthUser(result.user);
      setUser(authUser);
    } catch (err: any) {
      console.error('Email sign-in error:', err);
      throw err;
    }
  }, [buildAuthUser]);

  const logout = useCallback(async () => {
    await signOut(auth);
    setUser(null);
  }, []);

  const consumePrompt = useCallback(async (): Promise<boolean> => {
    if (!user) return false;
    if (user.isAdmin) return true; // Admins have unlimited

    if (user.promptsRemaining <= 0) return false;

    const newCount = user.promptsUsed + 1;
    const userRef = doc(db, 'users', user.uid);
    await setDoc(userRef, { promptsUsed: newCount }, { merge: true });

    setUser(prev => prev ? {
      ...prev,
      promptsUsed: newCount,
      promptsRemaining: Math.max(0, prev.maxPrompts - newCount),
    } : null);

    return true;
  }, [user]);

  const refreshPromptCount = useCallback(async () => {
    if (!user) return;
    const userRef = doc(db, 'users', user.uid);
    const userSnap = await getDoc(userRef);
    if (userSnap.exists()) {
      const promptsUsed = userSnap.data().promptsUsed || 0;
      // v1.6.1 — pick up a freshly granted allotment (e.g. admin just set
      // maxPrompts:5 after a contract signature) without requiring re-login
      const mp = userSnap.data().maxPrompts;
      setUser(prev => {
        if (!prev) return null;
        const maxPrompts = (typeof mp === 'number' && Number.isFinite(mp) && mp >= 0) ? mp : prev.maxPrompts;
        return {
          ...prev,
          promptsUsed,
          maxPrompts,
          promptsRemaining: prev.isAdmin ? Infinity : Math.max(0, maxPrompts - promptsUsed),
        };
      });
    }
  }, [user]);

  return (
    <AuthContext.Provider value={{ user, loading, signInWithGoogle, signInWithEmail, logout, consumePrompt, refreshPromptCount }}>
      {children}
    </AuthContext.Provider>
  );
};
