import { useEffect, useState, useCallback } from 'react';
import { api, getToken, setToken } from './api.js';
import Login from './components/Login.jsx';
import Inbox from './components/Inbox.jsx';
import Settings from './components/Settings.jsx';
import RecoveryCodes from './components/RecoveryCodes.jsx';
import DialogHost, { dialogs } from './components/Dialog.jsx';

// Hash routing: GitHub Pages has no server-side rewrites, so deep links must
// live after the '#'.
function useHashRoute() {
  const [hash, setHash] = useState(window.location.hash || '#/');
  useEffect(() => {
    const onChange = () => setHash(window.location.hash || '#/');
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return hash;
}

export default function App() {
  const hash = useHashRoute();
  const [state, setState] = useState({ loading: true, authed: false, enrolled: false });
  const [freshCodes, setFreshCodes] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const status = await api.status();
      setState({
        loading: false,
        authed: status.authenticated,
        enrolled: status.enrolled,
      });
    } catch {
      setState({ loading: false, authed: false, enrolled: false, offline: true });
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // Magic-link landing: #/magic?token=...
  useEffect(() => {
    if (!hash.startsWith('#/magic')) return;
    const token = new URLSearchParams(hash.split('?')[1] || '').get('token');
    if (!token) return;

    (async () => {
      try {
        const res = await api.magicVerify(token);
        setToken(res.token);
        // Strip the token from the URL so it isn't left in history.
        window.history.replaceState(null, '', window.location.pathname);
        window.location.hash = '#/';
        refresh();
      } catch (e) {
        window.location.hash = '#/';
        dialogs.alert(e.message, { title: 'Sign-in failed' });
      }
    })();
  }, [hash, refresh]);

  const onSignedIn = useCallback((token, recoveryCodes) => {
    setToken(token);
    if (recoveryCodes) setFreshCodes(recoveryCodes);
    refresh();
  }, [refresh]);

  const onSignOut = useCallback(async () => {
    await api.logout().catch(() => {});
    setToken(null);
    setState((s) => ({ ...s, authed: false }));
  }, []);

  // DialogHost renders above everything, including the signed-out screens,
  // so dialogs work on every route.
  const withDialogs = (content) => (
    <>
      {content}
      <DialogHost />
    </>
  );

  if (state.loading) {
    return withDialogs(<div className="center muted">Loading…</div>);
  }

  // Shown once, immediately after the first passkey is created.
  if (freshCodes) {
    return withDialogs(
      <RecoveryCodes codes={freshCodes} onDone={() => setFreshCodes(null)} />,
    );
  }

  if (!state.authed || !getToken()) {
    return withDialogs(<Login enrolled={state.enrolled} onSignedIn={onSignedIn} />);
  }

  const route = hash.replace(/^#/, '').split('?')[0];

  return withDialogs(
    <div className="app">
      <header className="topbar">
        <a href="#/" className="brand">
          <span className="brand-dot" />
          Voicemail
        </a>
        <nav>
          <a href="#/" className={route === '/' || route.startsWith('/vm') ? 'active' : ''}>Inbox</a>
          <a href="#/settings" className={route === '/settings' ? 'active' : ''}>Settings</a>
          <button className="link" onClick={onSignOut}>Sign out</button>
        </nav>
      </header>

      <main>
        {route === '/settings'
          ? <Settings onSignOut={onSignOut} />
          : <Inbox route={route} />}
      </main>
    </div>,
  );
}
