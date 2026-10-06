import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/index.css';

// A rebuild renames the lazy screen chunks, so a tab opened before it 404s on the next screen it loads.
// Reload once to pick up the new build; the guard stops a loop if the chunk is truly missing.
window.addEventListener('vite:preloadError', (e) => {
  try {
    if (sessionStorage.getItem('sb-reloaded')) return;
    sessionStorage.setItem('sb-reloaded', '1');
  } catch { /* private mode: reload anyway */ }
  e.preventDefault();
  window.location.reload();
});
window.addEventListener('load', () => setTimeout(() => { try { sessionStorage.removeItem('sb-reloaded'); } catch { /* ignore */ } }, 5000));

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
