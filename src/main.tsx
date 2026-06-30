import React from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import App from './App';
import { SessionProvider } from './contexts/SessionContext';
import { AuthProvider } from './contexts/AuthContext';
import { ErrorBoundary } from './components/ErrorBoundary';
import './styles/main.css';

// v1.4.2 — surface runtime errors that React's error boundary CANNOT catch:
// errors thrown outside render (event handlers, timers, async callbacks) and
// unhandled promise rejections. These don't blank the page on their own, but
// they previously vanished silently — making "why did this go blank" or "why
// did this prompt silently fail" impossible to diagnose from the console.
window.addEventListener('error', (event) => {
  // eslint-disable-next-line no-console
  console.error('[Stratageo] Uncaught runtime error:', event.error || event.message, event);
});
window.addEventListener('unhandledrejection', (event) => {
  // eslint-disable-next-line no-console
  console.error('[Stratageo] Unhandled promise rejection:', event.reason);
});

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Root element not found');

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <HashRouter>
      <AuthProvider>
        <SessionProvider>
          {/* Top-level backstop: if a narrower boundary inside App somehow
              doesn't catch a crash (or the crash is in App itself, outside
              any panel), this still prevents a fully blank page. */}
          <ErrorBoundary section="Stratageo">
            <App />
          </ErrorBoundary>
        </SessionProvider>
      </AuthProvider>
    </HashRouter>
  </React.StrictMode>
);
