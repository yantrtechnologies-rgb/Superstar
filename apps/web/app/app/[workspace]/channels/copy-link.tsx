'use client';

import { useState } from 'react';

/** A connect link the agency copies and sends to a client. */
export function CopyLink({ url, label }: { url: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="copy-link">
      <input readOnly value={url} aria-label={label} onFocus={(event) => event.currentTarget.select()} />
      <button type="button" className="btn" onClick={async () => {
        try {
          await navigator.clipboard.writeText(url);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        } catch { /* The field stays selectable for a manual copy. */ }
      }}>{copied ? 'Copied' : 'Copy link'}</button>
    </span>
  );
}
