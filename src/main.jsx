import React, { Component, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

class RootErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }
  componentDidCatch(error, errorInfo) {
    console.error('RootErrorBoundary caught fatal render error:', error, errorInfo);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          position: 'fixed',
          inset: 0,
          background: '#0d1117',
          color: '#f87171',
          padding: 32,
          fontFamily: 'Consolas, monospace',
          overflow: 'auto',
          zIndex: 999999
        }}>
          <h2 style={{ color: '#ef4444', marginBottom: 12, fontSize: 18 }}>Aurelia Audio — UI Render Error</h2>
          <pre style={{
            background: '#161b22',
            padding: 16,
            borderRadius: 8,
            whiteSpace: 'pre-wrap',
            fontSize: 12,
            lineHeight: 1.5,
            border: '1px solid rgba(255,255,255,0.1)'
          }}>
            {this.state.error?.stack || this.state.error?.message || String(this.state.error)}
          </pre>
          <div style={{ marginTop: 20, display: 'flex', gap: 12 }}>
            <button
              onClick={() => window.location.reload()}
              style={{
                padding: '8px 16px',
                background: '#f59e0b',
                color: '#000',
                border: 'none',
                borderRadius: 6,
                fontWeight: 'bold',
                cursor: 'pointer'
              }}
            >
              Reload App
            </button>
            <button
              onClick={() => {
                try {
                  indexedDB.deleteDatabase('AureliaAudioDB_v1');
                  localStorage.clear();
                  sessionStorage.clear();
                } catch (e) {}
                window.location.reload();
              }}
              style={{
                padding: '8px 16px',
                background: '#ef4444',
                color: '#fff',
                border: 'none',
                borderRadius: 6,
                fontWeight: 'bold',
                cursor: 'pointer'
              }}
            >
              Purge Database & Reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  </StrictMode>,
)
