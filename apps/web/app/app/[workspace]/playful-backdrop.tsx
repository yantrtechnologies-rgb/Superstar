/**
 * Superstar's own cartoon cast drifting behind the app content (decoration only: no clicks, hidden from screen
 * readers, and still for people who prefer reduced motion). Styles and movement live in globals.css (.playground).
 */

const eye = (cx: number, cy: number, r = 4) => (
  <g className="critter-eye">
    <circle cx={cx} cy={cy} r={r} fill="#1b1530" />
    <circle cx={cx + r * 0.35} cy={cy - r * 0.35} r={r * 0.35} fill="#fff" />
  </g>
);

function Starry() {
  return (
    <svg viewBox="0 0 100 100" width="92" height="92">
      <g className="critter-wave">
        <path d="M86 40 q10 -10 6 -22" stroke="#f59e0b" strokeWidth="7" strokeLinecap="round" fill="none" />
      </g>
      <path d="M50 8 L61.8 35.8 L91.9 38.4 L69 58.2 L75.9 87.6 L50 72 L24.1 87.6 L31 58.2 L8.1 38.4 L38.2 35.8 Z"
        fill="#fcd34d" stroke="#f59e0b" strokeWidth="6" strokeLinejoin="round" />
      {eye(42, 48)}{eye(58, 48)}
      <circle cx="36" cy="57" r="3.5" fill="#fb7185" opacity=".6" /><circle cx="64" cy="57" r="3.5" fill="#fb7185" opacity=".6" />
      <path d="M43 58 Q50 66 57 58" stroke="#1b1530" strokeWidth="3" strokeLinecap="round" fill="none" />
    </svg>
  );
}

function Rocky() {
  return (
    <svg viewBox="0 0 80 120" width="62" height="93">
      <g className="critter-flame">
        <path d="M29 82 Q40 116 51 82 Z" fill="#fb923c" />
        <path d="M35 82 Q40 102 45 82 Z" fill="#fde047" />
      </g>
      <path d="M22 66 L8 92 L25 85 Z M58 66 L72 92 L55 85 Z" fill="#f43f5e" />
      <path d="M40 6 C58 22 62 50 58 84 L22 84 C18 50 22 22 40 6 Z" fill="#f1f5ff" stroke="#c7d2fe" strokeWidth="2" />
      <path d="M40 6 C48 13 53 20 55 28 L25 28 C27 20 32 13 40 6 Z" fill="#f43f5e" />
      <circle cx="40" cy="50" r="13" fill="#7dd3fc" stroke="#3b82f6" strokeWidth="3" />
      {eye(35.5, 48, 2.6)}{eye(44.5, 48, 2.6)}
      <path d="M35 54 Q40 58 45 54" stroke="#1b1530" strokeWidth="2.2" strokeLinecap="round" fill="none" />
    </svg>
  );
}

function Bubbles() {
  return (
    <svg viewBox="0 0 100 90" width="84" height="76">
      <path d="M14 8 H86 Q96 8 96 18 V54 Q96 64 86 64 H42 L24 82 L29 64 H14 Q4 64 4 54 V18 Q4 8 14 8 Z" fill="#60a5fa" stroke="#2563eb" strokeWidth="3" />
      <circle cx="36" cy="30" r="7" fill="#fff" /><circle cx="64" cy="30" r="7" fill="#fff" />
      {eye(37, 31, 3.6)}{eye(65, 31, 3.6)}
      <path d="M40 44 Q50 54 60 44" stroke="#fff" strokeWidth="3.5" strokeLinecap="round" fill="none" />
      <path className="critter-heart" d="M50 -2 c-4 -6 -12 -2 -10 4 c1 4 10 10 10 10 s9 -6 10 -10 c2 -6 -6 -10 -10 -4 z" fill="#fb7185" />
    </svg>
  );
}

function Snap() {
  return (
    <svg viewBox="0 0 100 84" width="80" height="67">
      <rect x="30" y="6" width="30" height="16" rx="5" fill="#db2777" />
      <rect x="6" y="16" width="88" height="56" rx="13" fill="#f472b6" stroke="#db2777" strokeWidth="3" />
      <rect x="72" y="24" width="12" height="7" rx="3" fill="#fef3c7" />
      <circle cx="50" cy="43" r="19" fill="#fdf2f8" stroke="#be185d" strokeWidth="4" />
      <g className="critter-eye"><circle cx="50" cy="43" r="9" fill="#1b1530" /><circle cx="54" cy="39" r="3.2" fill="#fff" /></g>
      <path d="M40 66 Q50 72 60 66" stroke="#831843" strokeWidth="3" strokeLinecap="round" fill="none" />
    </svg>
  );
}

function Nimbus() {
  return (
    <svg viewBox="0 0 120 82" width="104" height="71">
      <path d="M30 72 Q8 72 10 53 Q4 31 28 31 Q34 11 58 15 Q78 4 90 27 Q114 27 110 51 Q114 72 92 72 Z" fill="#ede9fe" stroke="#c4b5fd" strokeWidth="3" />
      <path d="M44 45 Q48 40 52 45 M68 45 Q72 40 76 45" stroke="#5b21b6" strokeWidth="3" strokeLinecap="round" fill="none" />
      <circle cx="42" cy="54" r="4" fill="#f9a8d4" opacity=".7" /><circle cx="78" cy="54" r="4" fill="#f9a8d4" opacity=".7" />
      <path d="M54 54 Q60 60 66 54" stroke="#5b21b6" strokeWidth="3" strokeLinecap="round" fill="none" />
      <text className="critter-z" x="96" y="18" fontSize="14" fontWeight="800" fill="#a78bfa">z</text>
    </svg>
  );
}

function Zippy() {
  return (
    <svg viewBox="0 0 110 64" width="96" height="56">
      <path d="M2 40 q14 -6 22 2 q8 8 18 0" stroke="#6ee7b7" strokeWidth="3" strokeDasharray="5 6" strokeLinecap="round" fill="none" opacity=".8" />
      <path d="M22 32 L106 6 L72 58 L60 40 Z" fill="#a7f3d0" stroke="#059669" strokeWidth="3" strokeLinejoin="round" />
      <path d="M106 6 L60 40 L62 58" stroke="#059669" strokeWidth="2.5" fill="#6ee7b7" strokeLinejoin="round" />
      {eye(78, 24, 2.8)}{eye(87, 21, 2.8)}
    </svg>
  );
}

const sparkle = (
  <svg viewBox="0 0 24 24" width="18" height="18"><path d="M12 1 L14.5 9.5 L23 12 L14.5 14.5 L12 23 L9.5 14.5 L1 12 L9.5 9.5 Z" fill="#fde68a" /></svg>
);
const heart = (
  <svg viewBox="0 0 24 22" width="20" height="18"><path d="M12 21 C5 15 1 11.5 1 7 A5.5 5.5 0 0 1 12 4.5 A5.5 5.5 0 0 1 23 7 C23 11.5 19 15 12 21 Z" fill="#fb7185" /></svg>
);
const like = (
  <svg viewBox="0 0 24 24" width="20" height="20">
    <circle cx="12" cy="12" r="11" fill="#3b82f6" />
    <path d="M7 11 h2.5 v7 H7 Z M10.5 11 l3 -5 c1.4 0 2 1 1.6 2.2 L14.6 10.5 H18 c.9 0 1.5.8 1.3 1.7 l-1.1 4.6 c-.2.7 -.8 1.2 -1.5 1.2 H10.5 Z" fill="#fff" />
  </svg>
);

export function PlayfulBackdrop() {
  return (
    <div className="playground" aria-hidden="true">
      <div className="critter critter-1"><div className="critter-bob"><Starry /></div></div>
      <div className="critter critter-2"><div className="critter-bob"><Rocky /></div></div>
      <div className="critter critter-3"><div className="critter-bob"><Bubbles /></div></div>
      <div className="critter critter-4"><div className="critter-bob"><Snap /></div></div>
      <div className="critter critter-5"><div className="critter-bob"><Nimbus /></div></div>
      <div className="critter critter-6"><div className="critter-bob"><Zippy /></div></div>
      {[heart, like, sparkle, heart, sparkle, like, heart, sparkle].map((icon, index) => (
        <span key={index} className={`floaty floaty-${index + 1}`}>{icon}</span>
      ))}
    </div>
  );
}
