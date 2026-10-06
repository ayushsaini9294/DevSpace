/** The DevSpace mark: two overlapping copies joining into one. Decorative. */
export function LogoMark({ className = 'h-7 w-7' }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true" focusable="false">
      <rect width="32" height="32" rx="8" className="fill-accent" />
      <path
        d="M11 10.5 6.5 16l4.5 5.5M21 10.5l4.5 5.5-4.5 5.5M18 9l-4 14"
        fill="none"
        stroke="white"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
