import { useState } from 'react';

/**
 * Shown exactly once, right after the first passkey is created (or after
 * regenerating). The server only ever stored hashes, so there is no second
 * chance to see these — the UI makes that consequence explicit.
 */
export default function RecoveryCodes({ codes, onDone }) {
  const [confirmed, setConfirmed] = useState(false);
  const [copied, setCopied] = useState(false);

  const text = codes.join('\n');

  const copy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const download = () => {
    const blob = new Blob(
      [
        'Mint Voicemail — recovery codes\n',
        `Generated ${new Date().toLocaleString()}\n`,
        'Each code works once. Keep these somewhere safe and offline.\n\n',
        text,
        '\n',
      ],
      { type: 'text/plain' },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'voicemail-recovery-codes.txt';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="center">
      <div className="card wide">
        <h1>Save your recovery codes</h1>
        <p className="muted">
          These are your way back in if you lose your passkey <em>and</em> your email.
          Each code works once. <strong>This is the only time they'll be shown.</strong>
        </p>

        <div className="codes">
          {codes.map((c) => <code key={c}>{c}</code>)}
        </div>

        <div className="row">
          <button className="ghost" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
          <button className="ghost" onClick={download}>Download</button>
          <button className="ghost" onClick={() => window.print()}>Print</button>
        </div>

        <label className="check">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
          />
          I've saved these somewhere safe
        </label>

        <button className="primary" disabled={!confirmed} onClick={onDone}>
          Continue to inbox
        </button>
      </div>
    </div>
  );
}
