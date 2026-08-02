import { useEffect, useState } from 'react';
import { startRegistration } from '@simplewebauthn/browser';
import { api } from '../api.js';
import { pushSupported, currentSubscription, enablePush, disablePush } from '../push.js';
import RecoveryCodes from './RecoveryCodes.jsx';
import { dialogs } from './Dialog.jsx';

export default function Settings() {
  const [creds, setCreds] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [recovery, setRecovery] = useState({ remaining: 0, total: 10 });
  const [audit, setAudit] = useState([]);
  const [pushOn, setPushOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [newCodes, setNewCodes] = useState(null);

  const load = async () => {
    try {
      const [c, s, r, a] = await Promise.all([
        api.credentials(), api.sessions(), api.recoveryStatus(), api.auditLog(),
      ]);
      setCreds(c.credentials);
      setSessions(s.sessions);
      setRecovery(r);
      setAudit(a.events);
      if (pushSupported()) setPushOn(!!(await currentSubscription()));
    } catch (e) { setError(e.message); }
  };

  useEffect(() => { load(); }, []);

  const run = async (fn) => {
    setBusy(true); setError(null);
    try { await fn(); await load(); }
    catch (e) { setError(e.message || String(e)); }
    finally { setBusy(false); }
  };

  const addPasskey = () => run(async () => {
    const { options, challengeId } = await api.registerOptions({});
    const response = await startRegistration({ optionsJSON: options });
    const label = await dialogs.prompt('Name this device', deviceGuess(), {
      title: 'Add a passkey', confirmLabel: 'Save', placeholder: 'e.g. Laptop',
    });
    await api.registerVerify({ challengeId, response, label: label || 'Passkey' });
  });

  const togglePush = () => run(async () => {
    if (pushOn) { await disablePush(); setPushOn(false); }
    else { await enablePush(); setPushOn(true); }
  });

  if (newCodes) {
    return <RecoveryCodes codes={newCodes} onDone={() => setNewCodes(null)} />;
  }

  return (
    <div className="settings">
      {error && <div className="alert error">{error}</div>}

      <section className="card">
        <h2>Notifications</h2>
        <p className="muted">
          Email always goes to your Gmail through Apps Script. Push is per-device —
          enable it on each device you want alerts on.
        </p>
        {pushSupported() ? (
          <button className={pushOn ? 'ghost' : 'primary'} disabled={busy} onClick={togglePush}>
            {pushOn ? 'Disable push on this device' : 'Enable push on this device'}
          </button>
        ) : (
          <p className="muted small">
            This browser doesn't support push. On iPhone, add the app to your Home Screen first.
          </p>
        )}
      </section>

      <section className="card">
        <h2>Passkeys</h2>
        <p className="muted">
          Register every device you use. More passkeys means fewer ways to get stuck.
        </p>
        <ul className="rows">
          {creds.map((c) => (
            <li key={c.id}>
              <div>
                <strong>{c.label}</strong>
                <div className="muted small">
                  Added {new Date(c.created_at * 1000).toLocaleDateString()}
                  {c.last_used_at && ` · last used ${new Date(c.last_used_at * 1000).toLocaleDateString()}`}
                </div>
              </div>
              {creds.length > 1 && (
                <button
                  className="danger small"
                  onClick={() => run(() => api.removeCredential(c.id))}
                >
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
        <button className="primary" disabled={busy} onClick={addPasskey}>Add a passkey</button>
        {creds.length === 1 && (
          <p className="muted small">
            You only have one passkey. Add a second device so a lost phone isn't a lockout.
          </p>
        )}
      </section>

      <section className="card">
        <h2>Recovery codes</h2>
        <p className="muted">
          {recovery.remaining} of {recovery.total} unused.
          {recovery.remaining <= 3 && ' Running low — generate a fresh set.'}
        </p>
        <button
          className="ghost"
          disabled={busy}
          onClick={() => run(async () => {
            if (!(await dialogs.confirm(
              'Generate new codes? Your existing codes stop working immediately.',
              { title: 'New recovery codes', confirmLabel: 'Generate', danger: true },
            ))) return;
            const r = await api.recoveryRegenerate();
            setNewCodes(r.recoveryCodes);
          })}
        >
          Generate new codes
        </button>
      </section>

      <section className="card">
        <h2>Active sessions</h2>
        <ul className="rows">
          {sessions.map((s) => (
            <li key={s.id}>
              <div>
                <strong>{s.current ? 'This device' : shortUa(s.userAgent)}</strong>
                <div className="muted small">
                  {s.ip} · via {s.method?.replace('_', ' ')} ·
                  {' '}signed in {new Date(s.createdAt * 1000).toLocaleDateString()}
                </div>
              </div>
            </li>
          ))}
        </ul>
        {sessions.length > 1 && (
          <button className="danger" disabled={busy} onClick={() => run(api.revokeSessions)}>
            Sign out everywhere else
          </button>
        )}
      </section>

      <section className="card">
        <h2>Security log</h2>
        <p className="muted">Every sign-in and rejected attempt, newest first.</p>
        <ul className="rows log">
          {audit.slice(0, 25).map((e, i) => (
            <li key={i}>
              <div>
                <strong className={e.event.includes('reject') || e.event.includes('failed') ? 'warn' : ''}>
                  {e.event.replace(/_/g, ' ')}
                </strong>
                <div className="muted small">
                  {new Date(e.created_at * 1000).toLocaleString()} · {e.ip || 'no ip'}
                </div>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function deviceGuess() {
  const ua = navigator.userAgent;
  if (/Android/.test(ua)) return 'Android phone';
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows PC';
  return 'Passkey';
}

function shortUa(ua) {
  if (!ua) return 'Unknown device';
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows';
  return 'Browser';
}
