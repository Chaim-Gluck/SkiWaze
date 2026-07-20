interface Props {
  className?: string;
}

/**
 * SkiWaze full lockup: navigation-pin mascot (goggled skier on skis) + wordmark
 * ("Ski" in white-framed black so it reads on any background, "Waze" in the brand
 * gradient) + tagline. Mirrors the finalized brand asset.
 */
export function Logo({ className }: Props) {
  return (
    <svg
      className={className}
      viewBox="0 0 600 180"
      role="img"
      aria-label="SkiWaze — from A to B on the mountain"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id="lg-pin" x1="0.1" y1="0" x2="0.9" y2="1">
          <stop offset="0" stopColor="#33baff" />
          <stop offset="0.55" stopColor="#12a0e8" />
          <stop offset="1" stopColor="#00c853" />
        </linearGradient>
        <radialGradient id="lg-skin" cx="0.45" cy="0.4" r="0.75">
          <stop offset="0" stopColor="#ffe1bf" />
          <stop offset="1" stopColor="#f4b483" />
        </radialGradient>
        <linearGradient id="lg-beanie" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ff6b6b" />
          <stop offset="1" stopColor="#d84343" />
        </linearGradient>
        <linearGradient id="lg-cuff" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffd9d9" />
          <stop offset="1" stopColor="#ffb3b3" />
        </linearGradient>
        <radialGradient id="lg-pompom" cx="0.4" cy="0.35" r="0.8">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="1" stopColor="#ffd9d9" />
        </radialGradient>
        <linearGradient id="lg-lens" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#5ad1ff" />
          <stop offset="0.6" stopColor="#4a7dff" />
          <stop offset="1" stopColor="#8a5cff" />
        </linearGradient>
        <linearGradient id="lg-skiF" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="#ff8a3d" />
          <stop offset="1" stopColor="#ff3d5e" />
        </linearGradient>
        <linearGradient id="lg-skiB" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="#ffb15c" />
          <stop offset="1" stopColor="#ff6a7e" />
        </linearGradient>
        <linearGradient id="lg-word" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#2196f3" />
          <stop offset="1" stopColor="#00c853" />
        </linearGradient>
        <filter id="lg-soft" x="-40%" y="-40%" width="180%" height="180%">
          <feDropShadow dx="0" dy="5" stdDeviation="6" floodColor="#08324a" floodOpacity="0.32" />
        </filter>
        <clipPath id="lg-face">
          <circle cx="46" cy="56" r="36" />
        </clipPath>
      </defs>

      <g transform="translate(30,18)" filter="url(#lg-soft)">
        <path d="M46 4 C74 4 96 26 96 54 C96 88 46 128 46 128 C46 128 -4 88 -4 54 C-4 26 18 4 46 4 Z" fill="url(#lg-pin)" />
        <path d="M20 16 C6 26 2 44 8 60 C-2 40 6 18 26 10 Z" fill="#ffffff" opacity="0.22" />
        <g>
          <g fill="#ffffff">
            <circle cx="-3" cy="132" r="5.2" opacity="0.85" />
            <circle cx="-11" cy="137" r="3.6" opacity="0.6" />
            <circle cx="3" cy="140" r="3.2" opacity="0.6" />
            <circle cx="-14" cy="130" r="2.4" opacity="0.45" />
          </g>
          <path d="M108 40 L-2 134 Q-9 139 -14 131" fill="none" stroke="url(#lg-skiB)" strokeWidth="7" strokeLinecap="round" />
          <path d="M114 45 L4 139 Q-3 144 -8 136" fill="none" stroke="url(#lg-skiF)" strokeWidth="7" strokeLinecap="round" />
          <path d="M109 43 L2 135" stroke="#ffffff" strokeWidth="1.6" strokeLinecap="round" opacity="0.5" />
          <rect x="41" y="93" width="10" height="6.4" rx="2" transform="rotate(-40 46 96)" fill="#1c2a38" />
          <rect x="30" y="104" width="10" height="6.4" rx="2" transform="rotate(-40 35 107)" fill="#1c2a38" />
        </g>
        <circle cx="46" cy="56" r="36" fill="url(#lg-skin)" />
        <g clipPath="url(#lg-face)">
          <rect x="6" y="52" width="80" height="9" rx="4.5" fill="#c94141" />
          <ellipse cx="27" cy="72" rx="7" ry="5" fill="#ff9d7a" opacity="0.45" />
          <ellipse cx="63" cy="72" rx="7" ry="5" fill="#ff9d7a" opacity="0.45" />
          <path d="M37 74 Q46 82 55 74" fill="none" stroke="#c9743a" strokeWidth="2.6" strokeLinecap="round" />
        </g>
        <rect x="14" y="49" width="64" height="20" rx="10" fill="url(#lg-lens)" stroke="#2b3a55" strokeWidth="2.4" />
        <path d="M20 66 L40 51 L47 51 L24 68 Z" fill="#ffffff" opacity="0.35" />
        <path d="M52 66 L64 57 L69 58 L58 67 Z" fill="#ffffff" opacity="0.22" />
        <path d="M11 49 C10 22 26 13 46 13 C66 13 82 22 81 49 C60 43 32 43 11 49 Z" fill="url(#lg-beanie)" />
        <g stroke="#c94141" strokeWidth="1.4" opacity="0.6" fill="none">
          <path d="M24 45 C23 30 26 22 30 17" />
          <path d="M35 43 C34 28 35 20 37 15" />
          <path d="M46 42 L46 14" />
          <path d="M57 43 C58 28 57 20 55 15" />
          <path d="M68 45 C69 30 66 22 62 17" />
        </g>
        <path d="M10 47 C34 41 58 41 82 47 L82 54 C58 48 34 48 10 54 Z" fill="url(#lg-cuff)" />
        <circle cx="46" cy="12" r="7.5" fill="url(#lg-pompom)" />
      </g>

      <g transform="translate(172,4)" fontFamily="Segoe UI, system-ui, sans-serif" fontWeight="800">
        <text x="0" y="104" fontSize="60" letterSpacing="1" fill="#111a26" stroke="#ffffff" strokeWidth="3.4" paintOrder="stroke" strokeLinejoin="round">
          Ski<tspan fill="url(#lg-word)" stroke="none">Waze</tspan>
        </text>
        <text x="2" y="130" fontSize="17" letterSpacing="3.5" fill="#7fa0ba" fontWeight="600">
          FROM A TO B ON THE MOUNTAIN
        </text>
      </g>
    </svg>
  );
}
