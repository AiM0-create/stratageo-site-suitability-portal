import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { SessionProvider } from './contexts/SessionContext';
import { AuthProvider } from './contexts/AuthContext';
import './styles/main.css';

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Root element not found');

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <AuthProvider>
      <SessionProvider>
        <App />
      </SessionProvider>
    </AuthProvider>
  </React.StrictMode>
);
