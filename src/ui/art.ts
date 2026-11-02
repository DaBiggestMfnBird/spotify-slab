/**
 * The panel's fixed vector parts. Each is built once at load and never touched
 * by the refresh loop; only transforms move them.
 */

function fmt(value: number): string {
    return String(Math.round(value * 100) / 100);
}

function polar(radius: number, degrees: number, cx = 0, cy = 0): string {
    const angle = (degrees * Math.PI) / 180;
    return `${fmt(cx + radius * Math.cos(angle))} ${fmt(cy + radius * Math.sin(angle))}`;
}

/** Overall diameter, pokes included. Odd so the centre lands on a pixel. */
export const WHEEL_SIZE = 57;
/** Radius of the tyre, the circle that actually rolls along the tube. */
export const TYRE_RADIUS = 18.5;

const BOX = `viewBox="-28.5 -28.5 57 57" width="57" height="57" aria-hidden="true" focusable="false"`;

const CHROME = (id: string) => `
  <linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#F7F9F9"/><stop offset=".42" stop-color="#D7DCDF"/>
    <stop offset=".56" stop-color="#8F979C"/><stop offset=".78" stop-color="#C9CFD3"/>
    <stop offset="1" stop-color="#EEF1F2"/>
  </linearGradient>`;

/** Rubber, whitewall and rim: everything that looks the same at any angle. */
export const WHEEL_STATIC = `
<svg class="slab-wheel-base" ${BOX}>
  <defs>${CHROME("slab-chrome-rim")}</defs>
  <circle cy="2" r="19.5" fill="#000" opacity=".5"/>
  <circle r="${TYRE_RADIUS}" fill="#0E0D0D"/>
  <circle r="${TYRE_RADIUS - 0.5}" fill="none" stroke="#343332"/>
  <circle r="13.2" fill="none" stroke="#F6F0E4" stroke-width="2.6"/>
  <circle r="13.2" fill="none" stroke="#C4122C" stroke-width=".9"/>
  <circle r="11.8" fill="#15171A"/>
  <circle r="10.9" fill="none" stroke="url(#slab-chrome-rim)" stroke-width="1.9"/>
</svg>`;

/** A tapered rod, thick at the rim, kinked past the rubber, chopped square at the tip. */
function elbow(angle: number): string {
    const out = (radius: number, side: number, lean = 0) => {
        const a = ((angle + lean) * Math.PI) / 180;
        const radial = [Math.cos(a), Math.sin(a)];
        const tangent = [-radial[1], radial[0]];
        return `${fmt(radial[0] * radius + tangent[0] * side)} ${fmt(radial[1] * radius + tangent[1] * side)}`;
    };
    const body = `M${out(11.5, -2)}L${out(21, -1.9)}L${out(28.2, -1.5, 8)}L${out(28.2, 1.5, 8)}L${out(21, 1.9)}L${out(11.5, 2)}Z`;
    const shine = `M${out(12.5, -0.4)}L${out(21, -0.4)}L${out(27.2, -0.1, 8)}`;
    return `<path d="${body}" fill="#C4CACE" stroke="#0C0D0E" stroke-width=".8" stroke-linejoin="round"/><path d="${shine}" fill="none" stroke="#FFFFFF" stroke-width="1.1" stroke-linecap="butt" stroke-linejoin="round"/>`;
}

/**
 * The part that turns. The 84 elbows are the point: fat chrome that comes off the
 * rim, crosses the whitewall and the rubber, and kinks past the tyre, so the
 * outline can only be a swanga. A few bold spokes and a winged knock-off are all
 * the centre needs at this size.
 */
function wheelSpin(): string {
    let spokes = "";
    for (let i = 0; i < 10; i++) {
        spokes += `<path d="M${polar(2, i * 36)}L${polar(9.8, i * 36)}"/>`;
    }
    let elbows = "";
    for (let i = 0; i < 5; i++) elbows += elbow(i * 72 + 18);

    return `
<svg class="slab-wheel-spin" ${BOX}>
  <defs>${CHROME("slab-chrome-hub")}</defs>
  <g fill="none" stroke="#AEB5BA" stroke-width="1.2">${spokes}</g>
  ${elbows}
  <path d="M-7 -2.2L-2.2 -1.5L2.2 -1.5L7 -2.2L7 2.2L2.2 1.5L-2.2 1.5L-7 2.2Z" fill="url(#slab-chrome-hub)" stroke="#16181A" stroke-width=".7" stroke-linejoin="round"/>
  <circle r="2.2" fill="url(#slab-chrome-hub)" stroke="#16181A" stroke-width=".6"/>
</svg>`;
}

export const WHEEL_SPIN = wheelSpin();

/** The wheel first: solid tyre, white band, hub, and four straight pokes. */
function chipIcon(): string {
    let pokes = "";
    for (const a of [25, 115, 205, 295]) pokes += `<path d="M${polar(6.6, a, 10, 10)}L${polar(9.4, a, 10, 10)}"/>`;
    return `
<svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true" focusable="false">
  <g stroke="currentColor" stroke-width="2.2" stroke-linecap="round">${pokes}</g>
  <circle cx="10" cy="10" r="7.2" fill="currentColor"/>
  <circle cx="10" cy="10" r="4.6" fill="#141414" stroke="#FFFFFF" stroke-width="1.4"/>
  <circle cx="10" cy="10" r="1.7" fill="currentColor"/>
</svg>`;
}

export const CHIP_ICON = chipIcon();

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

export const CLOSE_ICON = `
<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true" focusable="false">
  <path d="M1.5 1.5l9 9m0-9l-9 9" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
</svg>`;

/** The kick plate's fixings, with each slot left at whatever angle it stopped. */
function screw(x: number, y: number, slot: number): string {
    return `<g transform="translate(${x} ${y})"><circle r="3.6" fill="#55595D"/><circle r="3" fill="#C9CDD0"/><path d="M${polar(2.7, slot)}L${polar(2.7, slot + 180)}" stroke="#2B2D30" stroke-width="1"/></g>`;
}

export const SILL_SCREWS = `
<svg class="slab-sill-screws" viewBox="0 0 400 84" width="400" height="84" aria-hidden="true" focusable="false">
  ${screw(9, 11, 20)}${screw(9, 73, 110)}${screw(391, 11, 70)}${screw(391, 73, 150)}
</svg>`;
