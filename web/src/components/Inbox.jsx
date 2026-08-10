import { useEffect, useState, useCallback, useRef } from 'react';
import { api } from '../api.js';
import { dialogs } from './Dialog.jsx';

// How long a press has to last to mean "select this" rather than "open this".
const LONG_PRESS_MS = 500;
// A press that slides this far is a scroll, not a press.
const LONG_PRESS_SLOP_PX = 10;

/**
 * True on a device with no hover — a phone or tablet being used by finger.
 * Not user-agent sniffing: a tablet with a mouse attached reports hover and is
 * treated as a desktop, which is the behaviour you'd want either way.
 */
function useTouchOnly() {
  const query = '(hover: none)';
  const [touchOnly, setTouchOnly] = useState(
    () => typeof window !== 'undefined' && window.matchMedia?.(query).matches === true,
  );

  useEffect(() => {
    const mq = window.matchMedia?.(query);
    if (!mq) return;
    const update = () => setTouchOnly(mq.matches);
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);

  return touchOnly;
}

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
  const [emptying, setEmptying] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [selecting, setSelecting] = useState(false);

  // On a phone the checkboxes would cost a column of width on every row for a
  // thing you rarely do, so they stay hidden until a long press asks for them.
  // With a mouse there's room and hovering makes them cheap, so they're always
  // on and this whole mode is inert.
  const touchOnly = useTouchOnly();
  const showCheckboxes = !touchOnly || selecting;

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

  // Switching tab or search changes which messages are on screen, and a
  // selection the user can no longer see is one they can't reason about.
  useEffect(() => { setSelected(new Set()); }, [filter, query]);

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

  /* ---- multi-select ---- */

  const toggleSelected = (id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const startSelecting = (id) => {
    setSelecting(true);
    toggleSelected(id);
  };

  // Emptying the selection is how you leave selection mode — untick the last
  // one, or use Cancel. Nothing to leave on a desktop, where the boxes stay.
  useEffect(() => { if (selected.size === 0) setSelecting(false); }, [selected]);

  // Only ever counts what's on screen: the poll can drop a message out of the
  // list between renders, and a stale id would silently do nothing.
  const visibleSelected = items.filter((v) => selected.has(v.id));
  const allSelected = items.length > 0 && visibleSelected.length === items.length;

  // `confirm`, when given, is the dialog options — message included. Actions
  // that can be undone from the Trash don't pass it.
  const bulk = async (action, confirm) => {
    const ids = visibleSelected.map((v) => v.id);
    if (!ids.length) return;
    if (confirm && !(await dialogs.confirm(confirm.message, confirm))) return;

    setBulkBusy(true);
    try {
      await api.bulk(action, ids);
      setSelected(new Set());
      await load();
    } catch (e) {
      setError(e.message);
      load();
    } finally {
      setBulkBusy(false);
    }
  };

  // Counts come from stats rather than the visible list, because a search can
  // hide trashed messages that emptying would still delete.
  const trashedSaved = stats.trashedSaved ?? 0;
  const emptyable = (stats.trashed ?? 0) - trashedSaved;

  // The app and the Worker deploy separately, so the app can be newer. Only
  // offer the button once the Worker's own response says it has the endpoint —
  // retentionDays ships in the same change. Otherwise the button would be
  // there to press and answer 404, and it starts working on its own the moment
  // the Worker catches up.
  const has = (feature) => stats.features?.includes(feature) ?? false;
  // retentionDays predates the features list, so it still stands in for
  // emptyTrash on a Worker deployed between the two changes.
  const canEmptyTrash = has('emptyTrash') || stats.retentionDays != null;
  const canBulk = has('bulk');

  const emptyTrash = async () => {
    const confirmed = await dialogs.confirm(
      `Permanently delete ${emptyable === 1 ? 'the 1 voicemail' : `all ${emptyable} voicemails`} ` +
      'in the trash, audio included? This cannot be undone.' +
      (trashedSaved
        ? ` ${trashedSaved === 1 ? 'One saved message stays' : `${trashedSaved} saved messages stay`} in the trash.`
        : ''),
      { title: 'Empty trash', confirmLabel: 'Empty trash', danger: true },
    );
    if (!confirmed) return;

    setEmptying(true);
    try { await api.emptyTrash(); await load(); }
    catch (e) { setError(e.message); load(); }
    finally { setEmptying(false); }
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

        {filter === 'trash' && stats.trashed > 0 && canEmptyTrash && (
          <div className="trash-actions">
            <span className="muted small">
              {emptyable === 1 ? '1 voicemail' : `${emptyable} voicemails`} can be cleared
              {trashedSaved > 0 && `, ${trashedSaved} saved ${trashedSaved === 1 ? 'one is' : 'ones are'} kept`}
              {stats.retentionDays ? ` · unsaved ones auto-delete after ${stats.retentionDays} days` : ''}
            </span>
            {emptyable > 0 && (
              <button className="danger small" onClick={emptyTrash} disabled={emptying}>
                {emptying ? 'Emptying…' : 'Empty trash'}
              </button>
            )}
          </div>
        )}
      </div>

      {/* Nothing on screen says the long press exists, so something has to. */}
      {canBulk && items.length > 0 && touchOnly && !selecting && (
        <p className="muted small select-hint">Press and hold a message to select several</p>
      )}

      {canBulk && items.length > 0 && showCheckboxes && (
        <div className={visibleSelected.length ? 'bulk-bar active' : 'bulk-bar'}>
          <label className="select-all">
            <input
              type="checkbox"
              checked={allSelected}
              // Some but not all: neither ticked nor empty, so the box says so.
              ref={(el) => { if (el) el.indeterminate = visibleSelected.length > 0 && !allSelected; }}
              onChange={() => setSelected(allSelected ? new Set() : new Set(items.map((v) => v.id)))}
              aria-label={allSelected ? 'Deselect all' : 'Select all'}
            />
            <span className="muted small">
              {visibleSelected.length ? `${visibleSelected.length} selected` : 'Select'}
            </span>
          </label>

          {touchOnly && (
            <button className="ghost small" onClick={() => setSelected(new Set())}>Cancel</button>
          )}

          {visibleSelected.length > 0 && (
            <div className="bulk-actions">
              {filter === 'trash' ? (
                <>
                  <button className="ghost small" disabled={bulkBusy}
                    onClick={() => bulk('restore')}>Restore</button>
                  <button className="danger small" disabled={bulkBusy}
                    onClick={() => bulk('purge', {
                      message: `Permanently delete ${countLabel(visibleSelected.length)}, audio included? This cannot be undone.`,
                      title: 'Delete forever',
                      confirmLabel: 'Delete',
                      danger: true,
                    })}>Delete forever</button>
                </>
              ) : (
                <>
                  <button className="ghost small" disabled={bulkBusy}
                    onClick={() => bulk('save')}>★ Save</button>
                  <button className="ghost small" disabled={bulkBusy}
                    onClick={() => bulk('unsave')}>☆ Unsave</button>
                  <button className="ghost small" disabled={bulkBusy}
                    onClick={() => bulk('read')}>Mark read</button>
                  <button className="ghost small" disabled={bulkBusy}
                    onClick={() => bulk('unread')}>Mark unread</button>
                  {/* Recoverable from Trash, so no confirmation — same as
                      deleting one message. */}
                  <button className="danger small" disabled={bulkBusy}
                    onClick={() => bulk('trash')}>Delete</button>
                </>
              )}
            </div>
          )}
        </div>
      )}

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
            selectable={canBulk && showCheckboxes}
            selected={selected.has(vm.id)}
            onToggleSelected={() => toggleSelected(vm.id)}
            onLongPress={canBulk && touchOnly ? () => startSelecting(vm.id) : null}
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
  vm, expanded, inTrash, selectable, selected, onToggleSelected, onLongPress,
  onToggleExpand, onToggleSaved, onToggleRead, onDelete, onRestore, onRetranscribe,
}) {
  const audioRef = useRef(null);
  const [playing, setPlaying] = useState(false);

  /* ---- press and hold to start selecting ---- */

  const pressTimer = useRef(null);
  const pressOrigin = useRef(null);
  // A long press ends in a click too. This swallows that one click, so
  // selecting a message doesn't also open it.
  const wasLongPress = useRef(false);

  const cancelPress = () => {
    clearTimeout(pressTimer.current);
    pressTimer.current = null;
  };

  // Timers outlive unmount otherwise, and would fire against a dead component.
  useEffect(() => cancelPress, []);

  const onTouchStart = (e) => {
    if (!onLongPress) return;
    const touch = e.touches?.[0];
    pressOrigin.current = touch ? { x: touch.clientX, y: touch.clientY } : null;
    wasLongPress.current = false;
    cancelPress();
    pressTimer.current = setTimeout(() => {
      wasLongPress.current = true;
      navigator.vibrate?.(10); // a tick of feedback where the platform offers it
      onLongPress();
    }, LONG_PRESS_MS);
  };

  const onTouchMove = (e) => {
    const touch = e.touches?.[0];
    if (!touch || !pressOrigin.current) return;
    const moved = Math.hypot(touch.clientX - pressOrigin.current.x, touch.clientY - pressOrigin.current.y);
    if (moved > LONG_PRESS_SLOP_PX) cancelPress(); // they're scrolling
  };

  const onTouchEnd = (e) => {
    cancelPress();
    // Suppress the click the browser synthesises after a touch. By now the
    // list has reflowed — checkboxes in, hint out — so that click lands
    // wherever the layout moved to, which is often the checkbox that just
    // appeared, instantly undoing the selection the press just made.
    if (wasLongPress.current) {
      e.preventDefault();
      // The synthesised click, if one comes at all, arrives before this timer
      // and is swallowed below. Clearing here rather than latching the flag
      // means a later, unrelated click is never eaten.
      setTimeout(() => { wasLongPress.current = false; }, 0);
    }
  };

  const handleClick = () => {
    cancelPress();
    if (wasLongPress.current) {
      wasLongPress.current = false;
      return;
    }
    onToggleExpand();
  };

  const togglePlay = (e) => {
    e.stopPropagation();
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) { el.play(); setPlaying(true); }
    else { el.pause(); setPlaying(false); }
  };

  return (
    <li className={`vm ${vm.isRead ? '' : 'unread'} ${expanded ? 'expanded' : ''} ${selected ? 'selected' : ''}`}>
      <div
        className="vm-head"
        onClick={handleClick}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={cancelPress}
        // iOS pops its own text-selection callout on a long press otherwise,
        // which lands on top of ours.
        onContextMenu={(e) => { if (onLongPress) e.preventDefault(); }}
      >
        {selectable && (
          // The whole row opens the message, so the checkbox has to keep its
          // clicks to itself or ticking one would also expand it.
          <input
            className="vm-select"
            type="checkbox"
            checked={selected}
            onChange={onToggleSelected}
            onClick={(e) => e.stopPropagation()}
            aria-label={`Select voicemail from ${vm.fromLabel}`}
          />
        )}

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

function countLabel(n) {
  return n === 1 ? 'this 1 voicemail' : `these ${n} voicemails`;
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
