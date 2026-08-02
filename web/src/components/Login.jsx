import { useState } from 'react';
import { startRegistration, startAuthentication } from '@simplewebauthn/browser';
import { api } from '../api.js';

/**
 * Three doors, one lock:
 *   passkey  — the everyday path, nothing to remember
 *   email    — magic link to the owner address        [failsafe]
 *   code     — one of ten single-use recovery codes   [failsafe]
 */
export default function Login({ enrolled, onSignedIn }) {
  const [mode, setMode] = useState(enrolled ? 'passkey' : 'setup');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const [setupCode, setSetupCode] = useState('');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');

  const run = async (fn) => {
    setBusy(true); setError(null); setNotice(null);
    try { await fn(); }
    catch (e) { setError(e.message || String(e)); }
    finally { setBusy(false); }
  };

  const signInWithPasskey = () => run(async () => {
    const { options, challengeId } = await api.loginOptions();
    const response = await startAuthentication({ optionsJSON: options });
    const result = await api.loginVerify({ challengeId, response });
    onSignedIn(result.token);
  });

  const firstTimeSetup = () => run(async () => {
    const { options, challengeId } = await api.registerOptions({ setupCode: setupCode.trim() });
    const response = await startRegistration({ optionsJSON: options });
    const result = await api.registerVerify({
      challengeId,
      response,
      label: deviceLabel(),
    });
    onSignedIn(result.token, result.recoveryCodes);
  });

  const sendMagicLink = () => run(async () => {
    const res = await api.magicRequest(email.trim());
    setNotice(res.message || 'Check your email for the sign-in link.');
  });

  const useRecoveryCode = () => run(async () => {
    const result = await api.recoveryUse(code.trim());
    setNotice(
      result.remaining === 0
        ? 'Signed in. That was your last recovery code — generate new ones in Settings.'
        : `Signed in. ${result.remaining} recovery codes left.`,
    );
    onSignedIn(result.token);
  });

  return (
    <div className="center">
      <div className="card auth-card">
        <div className="brand big">
          <span className="brand-dot" />
          Voicemail
        </div>

        {mode === 'setup' && (
          <>
            <h1>First-time setup</h1>
            <p className="muted">
              Enter the setup code you configured on the Worker, then create a passkey.
              You'll get recovery codes right after.
            </p>
            <input
              type="password"
              placeholder="Setup code"
              value={setupCode}
              onChange={(e) => setSetupCode(e.target.value)}
              autoComplete="one-time-code"
            />
            <button className="primary" disabled={busy || !setupCode} onClick={firstTimeSetup}>
              {busy ? 'Creating…' : 'Create passkey'}
            </button>
          </>
        )}

        {mode === 'passkey' && (
          <>
            <h1>Welcome back</h1>
            <p className="muted">Sign in with Face ID, Touch ID, or your security key.</p>
            <button className="primary" disabled={busy} onClick={signInWithPasskey}>
              {busy ? 'Waiting…' : 'Sign in with passkey'}
            </button>
            <div className="divider"><span>lost your device?</span></div>
            <div className="row">
              <button className="ghost" onClick={() => { setMode('email'); setError(null); }}>
                Email me a link
              </button>
              <button className="ghost" onClick={() => { setMode('code'); setError(null); }}>
                Use a recovery code
              </button>
            </div>
          </>
        )}

        {mode === 'email' && (
          <>
            <h1>Email a sign-in link</h1>
            <p className="muted">
              We'll send a one-time link to the owner address. It expires in 15 minutes.
            </p>
            <input
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
            />
            <button className="primary" disabled={busy || !email} onClick={sendMagicLink}>
              {busy ? 'Sending…' : 'Send link'}
            </button>
            <button className="link back" onClick={() => setMode('passkey')}>Back</button>
          </>
        )}

        {mode === 'code' && (
          <>
            <h1>Recovery code</h1>
            <p className="muted">
              Enter one of the codes you saved during setup. Each works once.
            </p>
            <input
              type="text"
              placeholder="XXXX-XXXX-XXXX"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              autoCapitalize="characters"
              spellCheck={false}
            />
            <button className="primary" disabled={busy || !code} onClick={useRecoveryCode}>
              {busy ? 'Checking…' : 'Sign in'}
            </button>
            <button className="link back" onClick={() => setMode('passkey')}>Back</button>
          </>
        )}

        {error && <div className="alert error">{error}</div>}
        {notice && <div className="alert ok">{notice}</div>}
      </div>
    </div>
  );
}

function deviceLabel() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  if (/Mac/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows PC';
  return 'Passkey';
}
