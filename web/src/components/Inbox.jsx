import { useEffect, useState, useCallback, useRef } from 'react';
import { api } from '../api.js';
import { dialogs } from './Dialog.jsx';

const FILTERS = [
  { key: 'inbox',  label: 'Inbox' },
  { key: 'unread', label: 'Unread' },
  { key: 'saved',  label: 'Saved' },
  { key: 'trash',  label: 'Trash' },
];

export default function Inbox({ route }) {
  const [filter, setFilter] = useState('inbox');
  const [query, setQuery] = useState('');
  const [items, setItems] = useState([]);
  const [stats, setStats] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [openId, setOpenId] = useState(null);

  // Deep link from a push notification or email: #/vm/<id>
  useEffect(() => {
    const m = /^\/vm\/([\w-]+)$/.exec(route || '');
    if (m) setOpenId(m[1]);
  }, [route]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [list, s] = await Promise.all([api.list(filter, query), api.stats()]);
      setItems(list.voicemails);
      setStats(s);
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [filter, query]);

  useEffect(() => { load(); }, [load]);

  // Debounced search.
  const [rawQuery, setRawQuery] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setQuery(rawQuery), 250);
    return () => clearTimeout(t);
  }, [rawQuery]);

  // Poll for new voicemail while the tab is visible. Push covers the
  // background case; this keeps an open tab honest without hammering the API.
  useEffect(() => {
    const tick = () => { if (document.visibilityState === 'visible') load(); };
    const id = setInterval(tick, 60_000);
    document.addEventListener('visibilitychange', tick);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', tick); };
  }, [load]);

  const mutate = (id, patch) => {
    setItems((prev) => prev.map((v) => (v.id === id ? { ...v, ...patch } : v)));
  };

  const toggleSaved = async (vm) => {
    mutate(vm.id, { isSaved: !vm.isSaved });               // optimistic
    try { await api.update(vm.id, { isSaved: !vm.isSaved }); }
    catch (e) { mutate(vm.id, { isSaved: vm.isSaved }); setError(e.message); }
  };

  const toggleRead = async (vm) => {
    mutate(vm.id, { isRead: !vm.isRead });
    try { await api.update(vm.id, { isRead: !vm.isRead }); }
    catch (e) { mutate(vm.id, { isRead: vm.isRead }); setError(e.message); }
  };

  const remove = async (vm) => {
    const permanent = filter === 'trash';
    if (permanent && !(await dialogs.confirm(
      'Delete this voicemail permanently? This cannot be undone.',
      { title: 'Delete forever', confirmLabel: 'Delete', danger: true },
    ))) return;
    setItems((prev) => prev.filter((v) => v.id !== vm.id));
    try { await api.remove(vm.id, permanent); await load(); }
    catch (e) { setError(e.message); load(); }
  };

  const restore = async (vm) => {
    setItems((prev) => prev.filter((v) => v.id !== vm.id));
    try { await api.restore(vm.id); await load(); }
    catch (e) { setError(e.message); load(); }
  };

  return (
    <div className="inbox">
      <div className="toolbar">
        <div className="tabs">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              className={filter === f.key ? 'tab active' : 'tab'}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
              {f.key === 'unread' && stats.unread > 0 && (
                <span className="badge">{stats.unread}</span>
              )}
            </button>
          ))}
        </div>
        <input
          className="search"
          type="search"
          placeholder="Search transcripts and callers…"
          value={rawQuery}
          onChange={(e) => setRawQuery(e.target.value)}
        />
      </div>

      {error && <div className="alert error">{error}</div>}

      {loading && items.length === 0 && <div className="muted pad">Loading…</div>}

      {!loading && items.length === 0 && (
        <div className="empty">
          <p>{query ? 'Nothing matches that search.' : emptyMessage(filter)}</p>
        </div>
      )}

      <ul className="vm-list">
        {items.map((vm) => (
          <VoicemailCard
            key={vm.id}
            vm={vm}
            expanded={openId === vm.id}
            inTrash={filter === 'trash'}
            onToggleExpand={() => setOpenId(openId === vm.id ? null : vm.id)}
            onToggleSaved={() => toggleSaved(vm)}
            onToggleRead={() => toggleRead(vm)}
            onDelete={() => remove(vm)}
            onRestore={() => restore(vm)}
            onRetranscribe={async () => {
              try {
                const r = await api.retranscribe(vm.id);
                mutate(vm.id, { transcript: r.transcript, transcriptStatus: 'done' });
              } catch (e) { setError(e.message); }
            }}
          />
        ))}
      </ul>
    </div>
  );
}

function VoicemailCard({
  vm, expanded, inTrash, onToggleExpand, onToggleSaved,
  onToggleRead, onDelete, onRestore, onRetranscribe,
}) {
  const audioRef = useRef(null);
  const [playing, setPlaying] = useState(false);

  const togglePlay = (e) => {
    e.stopPropagation();
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) { el.play(); setPlaying(true); }
    else { el.pause(); setPlaying(false); }
  };

  return (
    <li className={`vm ${vm.isRead ? '' : 'unread'} ${expanded ? 'expanded' : ''}`}>
      <div className="vm-head" onClick={onToggleExpand}>
        {vm.hasAudio && (
          <button className="play" onClick={togglePlay} aria-label={playing ? 'Pause' : 'Play'}>
            {playing ? '❚❚' : '▶'}
          </button>
        )}

        <div className="vm-main">
          <div className="vm-from">
            {!vm.isRead && <span className="dot" aria-label="Unread" />}
            {vm.fromLabel}
            {vm.fromCity && <span className="loc">{vm.fromCity}, {vm.fromState}</span>}
          </div>
          <div className="vm-preview">
            {vm.transcriptStatus === 'pending' && <em className="muted">Transcribing…</em>}
            {vm.transcriptStatus === 'failed' && <em className="muted">Transcript unavailable</em>}
            {vm.transcript}
          </div>
        </div>

        <div className="vm-meta">
          <span>{formatTime(vm.createdAt)}</span>
          <span className="muted">{formatDuration(vm.duration)}</span>
        </div>
      </div>

      {expanded && (
        <div className="vm-body">
          {vm.hasAudio && (
            <audio
              ref={audioRef}
              controls
              preload="none"
              src={vm.audioUrl}
              onEnded={() => setPlaying(false)}
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
            />
          )}

          {vm.transcript && <p className="transcript">{vm.transcript}</p>}

          {vm.confidence != null && vm.confidence < 0.6 && (
            <p className="muted small">
              Low-confidence transcript — worth listening to the audio.
            </p>
          )}

          <div className="vm-actions">
            {inTrash ? (
              <>
                <button className="ghost" onClick={onRestore}>Restore</button>
                <button className="danger" onClick={onDelete}>Delete forever</button>
              </>
            ) : (
              <>
                {canReply(vm.from) && (
                  <>
                    {/* tel:/sms: hand off to the phone's own dialer and
                        messaging app, so replying is one tap from the
                        transcript instead of copying the number out. */}
                    <a className="reply" href={`tel:${vm.from}`}>Call back</a>
                    <a className="reply" href={`sms:${vm.from}`}>Text back</a>
                  </>
                )}
                <button className="ghost" onClick={onToggleSaved}>
                  {vm.isSaved ? '★ Saved' : '☆ Save'}
                </button>
                <button className="ghost" onClick={onToggleRead}>
                  Mark {vm.isRead ? 'unread' : 'read'}
                </button>
                {vm.hasAudio && (
                  <a className="ghost" href={vm.audioUrl} download={`voicemail-${vm.id}.mp3`}>
                    Download
                  </a>
                )}
                {vm.transcriptStatus !== 'done' && vm.hasAudio && (
                  <button className="ghost" onClick={onRetranscribe}>Retry transcript</button>
                )}
                <button className="danger" onClick={onDelete}>Delete</button>
              </>
            )}
          </div>

          {vm.isSaved && !inTrash && (
            <p className="muted small">Saved messages are never auto-deleted.</p>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * Withheld, blocked, and anonymous callers arrive as things like "unknown"
 * or "anonymous" rather than a number. Offering a dial button for those just
 * launches the dialer with garbage in it.
 */
function canReply(from) {
  return typeof from === 'string' && /^\+?\d{7,15}$/.test(from.replace(/[\s()-]/g, ''));
}

function emptyMessage(filter) {
  if (filter === 'trash') return 'Trash is empty.';
  if (filter === 'saved') return 'No saved voicemails yet.';
  if (filter === 'unread') return "You're all caught up.";
  return 'No voicemails yet. Once call forwarding is active, they land here.';
}

function formatDuration(seconds) {
  const s = Number(seconds) || 0;
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function formatTime(epoch) {
  const d = new Date(epoch * 1000);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';

  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString([], sameYear
    ? { month: 'short', day: 'numeric' }
    : { month: 'short', day: 'numeric', year: 'numeric' });
}
