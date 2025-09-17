/**
 * Minimal neutral torso mannequin as an inline SVG data URL.
 * You can swap this anytime with a more detailed asset.
 */
const SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="720" height="900" viewBox="0 0 720 900">
  <defs>
    <linearGradient id="g" x1="0" x2="0" y1="0" y2="1">
      <stop offset="0" stop-color="#f3f4f7"/>
      <stop offset="1" stop-color="#e6e8ef"/>
    </linearGradient>
  </defs>
  <rect width="100%" height="100%" fill="#f7f7f7"/>
  <g transform="translate(360,430)">
    <path d="M-60,-170 C-40,-210 40,-210 60,-170 L68,-40 C72,20 60,80 0,80 C-60,80 -72,20 -68,-40 Z"
          fill="url(#g)" stroke="#d3d7e3" stroke-width="2"/>
    <rect x="-16" y="80" width="32" height="90" rx="6" fill="#dfe3ec"/>
  </g>
</svg>`;
export const MANNEQUIN_DATA_URL = `data:image/svg+xml;base64,${btoa(SVG)}`;
