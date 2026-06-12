import React, { useState } from 'react';
import { useAuth } from '../contexts/AuthContext';

export const LoginScreen: React.FC = () => {
  const { signInWithGoogle, signInWithEmail } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showEmailForm, setShowEmailForm] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const handleGoogleSignIn = async () => {
    setLoading(true);
    setError(null);
    try {
      await signInWithGoogle();
    } catch (err: any) {
      setError(err.message || 'Sign-in failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleEmailSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) { setError('Please enter email and password.'); return; }
    setLoading(true);
    setError(null);
    try {
      await signInWithEmail(email, password);
    } catch (err: any) {
      // Friendly error messages
      if (err.code === 'auth/invalid-credential' || err.code === 'auth/wrong-password' || err.code === 'auth/user-not-found') {
        setError('Invalid email or password.');
      } else if (err.code === 'auth/too-many-requests') {
        setError('Too many attempts. Please try again later.');
      } else {
        setError(err.message || 'Sign-in failed.');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="sg-login-screen">
      <div className="sg-login-card">
        <div className="sg-login-brand">
          <span className="sg-login-logo-strata">STRATA</span>
          <span className="sg-login-logo-geo">GEO</span>
        </div>
        <h1 className="sg-login-title">Site Suitability Portal</h1>
        <p className="sg-login-subtitle">
          AI-powered location intelligence for smarter site selection decisions.
          Evaluate any business type across Indian cities with real spatial data.
        </p>

        <div className="sg-login-features">
          <div className="sg-login-feature">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="icon-sm">
              <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/>
              <circle cx="12" cy="10" r="3"/>
            </svg>
            <span>Real-time spatial analysis across 15+ Indian cities</span>
          </div>
          <div className="sg-login-feature">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="icon-sm">
              <path d="M12 20V10"/>
              <path d="M18 20V4"/>
              <path d="M6 20v-4"/>
            </svg>
            <span>Multi-criteria scoring with explainable methodology</span>
          </div>
          <div className="sg-login-feature">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="icon-sm">
              <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/>
              <polyline points="14,2 14,8 20,8"/>
            </svg>
            <span>Exportable PDF reports for stakeholder presentations</span>
          </div>
        </div>

        {/* Google Sign-in — primary for clients */}
        <button
          className="sg-login-btn"
          onClick={handleGoogleSignIn}
          disabled={loading}
        >
          {loading && !showEmailForm ? (
            <span className="sg-login-btn-loading">Signing in...</span>
          ) : (
            <>
              <svg viewBox="0 0 24 24" width="20" height="20">
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
              </svg>
              <span>Continue with Google</span>
            </>
          )}
        </button>

        {/* Divider */}
        <div className="sg-login-divider">
          <span>or</span>
        </div>

        {/* Email/Password — for Stratageo team */}
        {!showEmailForm ? (
          <button
            className="sg-login-btn sg-login-btn-email"
            onClick={() => setShowEmailForm(true)}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20">
              <rect x="2" y="4" width="20" height="16" rx="2"/>
              <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>
            </svg>
            <span>Sign in with Email</span>
          </button>
        ) : (
          <form className="sg-login-email-form" onSubmit={handleEmailSignIn}>
            <input
              type="email"
              placeholder="Email address"
              value={email}
              onChange={e => setEmail(e.target.value)}
              className="sg-login-input"
              autoFocus
            />
            <input
              type="password"
              placeholder="Password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              className="sg-login-input"
            />
            <button type="submit" className="sg-login-btn sg-login-btn-submit" disabled={loading}>
              {loading ? 'Signing in...' : 'Sign In'}
            </button>
            <button type="button" className="sg-login-back" onClick={() => { setShowEmailForm(false); setError(null); }}>
              Back to all options
            </button>
          </form>
        )}

        {error && <p className="sg-login-error">{error}</p>}

        <p className="sg-login-note">
          Sign in to access your complimentary analysis sessions.
          Each account includes 10 AI-powered site evaluations.
        </p>
      </div>

      <div className="sg-login-footer">
        <span>Powered by Stratageo</span>
        <span>stratageo.in</span>
      </div>
    </div>
  );
};
