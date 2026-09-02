import { useEffect, useState, useCallback } from 'react';
import { api } from '../api.js';
import { dialogs } from './Dialog.jsx';

const CATEGORY_LABELS = {
  debt_collection: 'Debt collection',
  sales: 'Sales',
  medical: 'Medical',
  financial: 'Financial',
  delivery: 'Delivery',
  government: 'Government',
  legal: 'Legal',
  scam_or_spam: 'Spam',
  personal: 'Personal',
  other: 'Other',
};

/**
 * Callers, grouped by who they actually are rather than what number they used.
 *
 * The number is a poor identity — an agency rotates through a dozen of them —
 * so groups are built from the organisation each caller names in the message.
 * Corrections here are permanent: renaming or merging pins the group so later
 * messages join it instead of starting a rival one.
 */
export default function Callers({ onOpenGroup }) {
  const [callers, setCallers] = useState([]);
  const [categories, setCategories] = useState([]);
  // Signed by the Worker and short-lived: a plain download can't send an
  // Authorization header, so the link carries its own scoped credential.
  const [exportUrl, setExportUrl] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null);

  const load = useCallback(async () => {
    try {
      const data = await api.callers();
      setCallers(data.callers);
      setCategories(data.categories || []);
      setExportUrl(data.exportUrl || null);
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const run = async (fn) => {
    setBusy(true);
    setError(null);
    try { await fn(); await load(); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  // Identification is a model call per message, so it runs in small batches
  // rather than one long request that would time out and lose the lot.
  const identifyAll = () => run(async () => {
    for (let i = 0; i < 40; i++) {
      const r = await api.identifyPending(5);
      setProgress(r.remaining);
      if (!r.remaining) break;
      // A batch that identifies nothing is failing, not finishing — stop
      // rather than spinning through forty rounds of the same error.
      if (!r.identified) break;
    }
    setProgress(null);
  });

  const rename = (caller) => run(async () => {
    const name = await dialogs.prompt('Name for this caller', caller.name, {
      title: 'Rename group',
      confirmLabel: 'Save',
    });
    if (!name || name === caller.name) return;
    await api.updateCaller(caller.id, { name });
  });

  const recategorize = (caller) => run(async () => {
    const list = categories.map((c) => CATEGORY_LABELS[c] || c).join(', ');
    const value = await dialogs.prompt(
      `Category for ${caller.name}. One of: ${list}`,
      CATEGORY_LABELS[caller.category] || '',
      { title: 'Change category', confirmLabel: 'Save' },
    );
    if (!value) return;

    const key = Object.keys(CATEGORY_LABELS).find(
      (k) => CATEGORY_LABELS[k].toLowerCase() === value.trim().toLowerCase() || k === value.trim(),
    );
    if (!key) {
      setError(`"${value}" isn't one of the categories.`);
      return;
    }
    await api.updateCaller(caller.id, { category: key });
  });

  const merge = (caller) => run(async () => {
    const others = callers.filter((c) => c.id !== caller.id);
    if (!others.length) {
      setError('Nothing to merge into yet.');
      return;
    }
    const target = await dialogs.prompt(
      `Merge "${caller.name}" into which group? Type its name.`,
      '',
      { title: 'Merge groups', confirmLabel: 'Merge', placeholder: others[0].name },
    );
    if (!target) return;

    const match = others.find((c) => c.name.toLowerCase() === target.trim().toLowerCase());
    if (!match) {
      setError(`No group called "${target}".`);
      return;
    }
    await api.mergeCaller(caller.id, match.id);
  });

  const ungroup = (caller) => run(async () => {
    const okay = await dialogs.confirm(
      `Ungroup "${caller.name}"? Its voicemails stay, but lose this grouping and ` +
      'will be re-identified.',
      { title: 'Ungroup', confirmLabel: 'Ungroup', danger: true },
    );
    if (!okay) return;
    await api.deleteCaller(caller.id);
  });


  if (loading) return <div className="muted pad">Loading…</div>;

  return (
    <div className="callers">
      {error && <div className="alert error">{error}</div>}

      <section className="card">
        <h2>Who's been calling</h2>
        <p className="muted">
          Grouped by the organisation named in each message, so one caller stays
          together even when they ring from a different number each time.
        </p>
        <div className="row">
          <button className="ghost" disabled={busy} onClick={identifyAll}>
            {busy && progress !== null ? `Identifying… ${progress} left` : 'Identify new messages'}
          </button>
          {exportUrl && (
            <a className="ghost" href={exportUrl} download="voicemail-callers.vcf">
              Export as contacts
            </a>
          )}
        </div>
        <p className="muted small">
          Importing that file into your phone's contacts makes the dialer show
          these names when they call — across every number each one uses.
        </p>
      </section>

      {callers.length === 0 && (
        <div className="empty">
          <p>No callers identified yet. Use “Identify new messages” above.</p>
        </div>
      )}

      <ul className="caller-list">
        {callers.map((c) => (
          <li key={c.id} className="caller">
            <div className="caller-head">
              <div>
                <button className="caller-name" onClick={() => onOpenGroup?.(c)}>
                  {c.name}
                </button>
                <div className="muted small">
                  {CATEGORY_LABELS[c.category] || 'Uncategorised'}
                  {' · '}
                  {c.total} message{c.total === 1 ? '' : 's'}
                  {c.unread > 0 && <span className="badge">{c.unread}</span>}
                  {c.numbers.length > 1 && ` · ${c.numbers.length} numbers`}
                  {c.pinned && ' · edited'}
                </div>
              </div>
            </div>

            {c.numbers.length > 0 && (
              <div className="caller-numbers">
                {c.numbers.map((n) => <code key={n}>{n}</code>)}
              </div>
            )}

            <div className="caller-actions">
              <button className="ghost small" onClick={() => rename(c)}>Rename</button>
              <button className="ghost small" onClick={() => recategorize(c)}>Category</button>
              <button className="ghost small" onClick={() => merge(c)}>Merge</button>
              <button className="danger small" onClick={() => ungroup(c)}>Ungroup</button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
