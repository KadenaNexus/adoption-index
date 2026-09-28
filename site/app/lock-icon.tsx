// Gold padlock drawn as SVG so it looks the same on every platform (emoji rendering varies).
export default function LockIcon({ size = 30 }: { size?: number }) {
  return <svg className="lock-svg" width={size * 0.8} height={size} viewBox="0 0 24 30" aria-hidden="true" focusable="false">
    <path d="M6.5 13V9a5.5 5.5 0 0 1 11 0v4" fill="none" stroke="#9aa9b8" strokeWidth="2.6" strokeLinecap="round"/>
    <rect x="2" y="12.5" width="20" height="16" rx="3.2" fill="#e8a916"/>
    <rect x="2" y="12.5" width="20" height="6" rx="3" fill="#f5c542" opacity=".55"/>
    <circle cx="12" cy="19.6" r="2.1" fill="#5b4210"/>
    <path d="M11 20.6h2l.5 4.2h-3z" fill="#5b4210"/>
  </svg>;
}
