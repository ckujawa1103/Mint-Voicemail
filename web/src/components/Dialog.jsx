import { useEffect, useState, useRef } from 'react';

// In-app replacements for window.confirm / prompt / alert.
//
// The native dialogs stamp "ckujawa1103.github.io says" across the top and
// cannot be styled — which looks like a browser warning rather than part of
// the app. These are promise-based so call sites read the same as before:
//
//   if (!(await dialogs.confirm('Delete?', { danger: true }))) return;
//
// A module-level subscriber keeps this callable from anywhere without
// threading context through every component.

let notify = null;
let seq = 0;

function open(config) {
  return new Promise((resolve) => {
    if (!notify) {
      // DialogHost isn't mounted — fail closed rather than silently
      // proceeding with a destructive action.
      resolve(config.kind === 'alert' ? undefined : null);
      return;
    }
    notify({ ...config, id: ++seq, resolve });
  });
}

export const dialogs = {
  confirm: (message, opts = {}) =>
    open({ kind: 'confirm', message, ...opts }).then((v) => v === true),
  prompt: (message, defaultValue = '', opts = {}) =>
    open({ kind: 'prompt', message, defaultValue, ...opts }),
  alert: (message, opts = {}) => open({ kind: 'alert', message, ...opts }),
};

export default function DialogHost() {
  const [dialog, setDialog] = useState(null);
  const [value, setValue] = useState('');
  const inputRef = useRef(null);
  const confirmRef = useRef(null);

  useEffect(() => {
    notify = (d) => {
      setValue(d.defaultValue ?? '');
      setDialog(d);
    };
    return () => { notify = null; };
  }, []);

  // Focus the field you're most likely to act on.
  useEffect(() => {
    if (!dialog) return;
    const target = dialog.kind === 'prompt' ? inputRef.current : confirmRef.current;
    target?.focus();
  }, [dialog]);

  if (!dialog) return null;

  const close = (result) => {
    dialog.resolve(result);
    setDialog(null);
  };

  const cancel = () => close(dialog.kind === 'confirm' ? false : null);
  const accept = () => close(dialog.kind === 'prompt' ? value : true);

  const onKeyDown = (e) => {
    if (e.key === 'Escape') cancel();
    if (e.key === 'Enter' && dialog.kind !== 'alert') accept();
  };

  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(e) => { if (e.target === e.currentTarget) cancel(); }}
      onKeyDown={onKeyDown}
      role="presentation"
    >
      <div className="dialog" role="alertdialog" aria-modal="true" aria-label={dialog.message}>
        {dialog.title && <h2>{dialog.title}</h2>}
        <p>{dialog.message}</p>

        {dialog.kind === 'prompt' && (
          <input
            ref={inputRef}
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={dialog.placeholder || ''}
          />
        )}

        <div className="dialog-actions">
          {dialog.kind !== 'alert' && (
            <button className="ghost" onClick={cancel}>
              {dialog.cancelLabel || 'Cancel'}
            </button>
          )}
          <button
            ref={confirmRef}
            className={dialog.danger ? 'danger' : 'primary'}
            onClick={accept}
          >
            {dialog.confirmLabel || (dialog.kind === 'alert' ? 'OK' : 'Confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}
