/** The deck-lid nameplate. Owned by the lettering, like the neon. */

const CHROME = (id: string) => `
  <linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#F7F9F9"/><stop offset=".42" stop-color="#D7DCDF"/>
    <stop offset=".56" stop-color="#8F979C"/><stop offset=".78" stop-color="#C9CFD3"/>
    <stop offset="1" stop-color="#EEF1F2"/>
  </linearGradient>`;

/**
 * Badge lettering: cut polygons, the way letters are stamped for a deck lid.
 * Bevel comes from the chrome ramp, and a dark copy underneath seats it on the
 * paint, with no filter involved.
 */
const LETTERS = [
    // S
    "M2.5 0H14V4H4V8H11.5L14 10.5V17.5L11.5 20H0V16H10V12H2.5L0 9.5V2.5Z",
    // L
    "M16.5 0H20.5V16H28.5V20H18.5L16.5 18Z",
    // A
    "M33.5 0H42.5L45.5 3V20H41.5V14H34.5V20H30.5V3ZM34.5 4V10H41.5V4Z",
    // B
    "M48 0H60L63 3V7.5L60.8 10L63 12.5V17L60 20H48ZM52 4V8H59V4ZM52 12V16H59V12Z",
].join("");

export const EMBLEM = `
<svg class="slab-emblem" viewBox="0 0 64 22" width="64" height="22" role="img" aria-label="SLAB" focusable="false">
  <defs>${CHROME("slab-chrome-badge")}</defs>
  <path d="${LETTERS}" transform="translate(.4 1.3)" fill="#1E0208" fill-rule="evenodd" opacity=".8"/>
  <path d="${LETTERS}" fill="url(#slab-chrome-badge)" fill-rule="evenodd"/>
</svg>`;

