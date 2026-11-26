'use client';

import { useState } from 'react';

/** The text of a reminded post, with a button that copies it for pasting into the network. */
export function CopyText({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="copy-text">
      <textarea readOnly value={text} aria-label={label} rows={Math.min(10, Math.max(3, text.split('\n').length + 1))}
        onFocus={(event) => event.currentTarget.select()} />
      <button type="button" className="btn" onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        } catch { /* The field stays selectable for a manual copy. */ }
      }}>{copied ? 'Copied' : 'Copy text'}</button>
    </div>
  );
}
