type P = { size?: number };
const base = (size: number) => ({
  width: size,
  height: size,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
});

export const Check = ({ size = 16 }: P) => (
  <svg {...base(size)}><path d="M3 8.5l3.2 3L13 4.5" /></svg>
);
export const ArrowUp = ({ size = 16 }: P) => (
  <svg {...base(size)}><path d="M8 13V3M4 7l4-4 4 4" /></svg>
);
export const ArrowDown = ({ size = 16 }: P) => (
  <svg {...base(size)}><path d="M8 3v10M4 9l4 4 4-4" /></svg>
);
export const Dots = ({ size = 16 }: P) => (
  <svg {...base(size)} fill="currentColor" stroke="none">
    <circle cx="3" cy="8" r="1.4" /><circle cx="8" cy="8" r="1.4" /><circle cx="13" cy="8" r="1.4" />
  </svg>
);
export const Chevron = ({ size = 16, open }: P & { open: boolean }) => (
  <svg {...base(size)} style={{ transform: open ? "rotate(90deg)" : undefined, transition: "transform .12s" }}>
    <path d="M6 4l4 4-4 4" />
  </svg>
);
export const Branch = ({ size = 14 }: P) => (
  <svg {...base(size)}>
    <circle cx="4.5" cy="3.5" r="1.5" /><circle cx="4.5" cy="12.5" r="1.5" /><circle cx="11.5" cy="5" r="1.5" />
    <path d="M4.5 5v6M11.5 6.5c0 3-7 2-7 4.5" />
  </svg>
);
export const Refresh = ({ size = 14 }: P) => (
  <svg {...base(size)}><path d="M13 8a5 5 0 1 1-1.5-3.5M13 2.5v3h-3" /></svg>
);
