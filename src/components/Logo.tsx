/** Three trees on a branch line: the Grove mark. */
export default function Logo({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <rect width="64" height="64" rx="14" fill="var(--accent)" />
      <path d="M12 46h40" stroke="#fff" strokeWidth="3" strokeLinecap="round" opacity=".6" />
      <circle cx="20" cy="30" r="8" fill="#fff" />
      <circle cx="44" cy="30" r="8" fill="#fff" />
      <circle cx="32" cy="22" r="10" fill="#fff" />
      <path d="M20 38v8M32 32v14M44 38v8" stroke="#fff" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}
