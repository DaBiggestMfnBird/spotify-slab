/**
 * The panel's fixed vector parts. Each is built once at load and never touched
 * by the refresh loop; only transforms and opacity move them.
 */

function fmt(value: number): string {
    return String(Math.round(value * 100) / 100);
}

function polar(radius: number, degrees: number, cx = 0, cy = 0): string {
    const angle = (degrees * Math.PI) / 180;
    return `${fmt(cx + radius * Math.cos(angle))} ${fmt(cy + radius * Math.sin(angle))}`;
}

/** Radius of the tyre, the circle that actually rolls along the tube. */
export const TYRE_RADIUS = 21;
/** The wheel's box: the tyre and its shadow. Odd so the centre lands on a pixel. */
export const WHEEL_SIZE = 47;
/**
 * Where the poke's tip sits, seen face-on. An 84's elbows and hub stand out
 * sideways from the wheel, so from where you stand the cone's point lands a
 * little down and to the right of the axle. It is a fact of the viewpoint, not
 * of the wheel, so it never turns; the knock-off turns about it.
 */
export const POKE_X = 1.6;
export const POKE_Y = 2.3;

const HALF = WHEEL_SIZE / 2;
const BOX = `viewBox="${-HALF} ${-HALF} ${WHEEL_SIZE} ${WHEEL_SIZE}" width="${WHEEL_SIZE}" height="${WHEEL_SIZE}" aria-hidden="true" focusable="false"`;

const CHROME = (id: string) => `
  <linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#F7F9F9"/><stop offset=".42" stop-color="#D7DCDF"/>
    <stop offset=".56" stop-color="#8F979C"/><stop offset=".78" stop-color="#C9CFD3"/>
    <stop offset="1" stop-color="#EEF1F2"/>
  </linearGradient>`;

/**
 * Rubber, the Vogue band and the rim: everything that looks the same at any
 * angle. Vogues are a narrow whitewall with a gold line on the rim side, "mayo
 * and mustard"; the red line is a 2019 anniversary edition, not the tyre a
 * slab rides on.
 */
export const WHEEL_STATIC = `
<svg class="slab-wheel-base" ${BOX}>
  <defs>${CHROME("slab-chrome-rim")}</defs>
  <circle cy="2" r="${TYRE_RADIUS + 1}" fill="#000" opacity=".5"/>
  <circle r="${TYRE_RADIUS}" fill="#0E0D0D"/>
  <circle r="${TYRE_RADIUS - 0.6}" fill="none" stroke="#343332" stroke-width=".7"/>
  <circle r="17.6" fill="none" stroke="#F4F0E6" stroke-width="1.45"/>
  <circle r="16.15" fill="none" stroke="#E2B53A" stroke-width=".85"/>
  <circle r="13.3" fill="none" stroke="url(#slab-chrome-rim)" stroke-width="1.8"/>
  <circle r="12.4" fill="#121416"/>
</svg>`;

/**
 * The part that turns with the road: thirty thick, straight elbow spokes,
 * tapered from the rim to the elbow ring. Not cross-laced; that's a Dayton.
 */
function wheelSpokes(): string {
    let spokes = "";
    for (let i = 0; i < 30; i++) {
        const a = i * 12;
        spokes += `<path d="M${polar(12.3, a - 2.9)}L${polar(6.8, a - 3.8)}L${polar(6.8, a + 3.8)}L${polar(12.3, a + 2.9)}Z" fill="#B9C0C5"/>`;
        spokes += `<path d="M${polar(12.05, a - 1.1)}L${polar(7.05, a - 1.5)}" stroke="#FFFFFF" stroke-width=".5"/>`;
    }
    return `<svg class="slab-wheel-spokes" ${BOX}>${spokes}</svg>`;
}

export const WHEEL_SPOKES = wheelSpokes();

/**
 * The poke itself: a smooth chrome cone where the spokes merge into the hub
 * barrel, standing proud of the wheel and throwing its shadow down-right onto
 * the spokes. Lit from the top left like everything else on the car.
 */
export const WHEEL_CONE = `
<svg class="slab-wheel-cone" ${BOX}>
  <defs>
   <radialGradient id="slab-poke-cone" cx=".34" cy=".30" r=".75">
     <stop offset="0" stop-color="#FFFFFF"/><stop offset=".28" stop-color="#EEF1F2"/>
     <stop offset=".68" stop-color="#9EA6AB"/><stop offset="1" stop-color="#4E565B"/>
   </radialGradient>
   <radialGradient id="slab-poke-cast" cx=".5" cy=".5" r=".5">
     <stop offset="0" stop-color="#000" stop-opacity=".75"/><stop offset=".55" stop-color="#000" stop-opacity=".38"/>
     <stop offset="1" stop-color="#000" stop-opacity="0"/>
   </radialGradient>
  </defs>
  <ellipse cx="${fmt(POKE_X + 2.5)}" cy="${fmt(POKE_Y + 3.2)}" rx="9.3" ry="8.4" fill="url(#slab-poke-cast)"/>
  <circle r="7.15" fill="none" stroke="#F5F7F8" stroke-width="1.1"/>
  <path d="M${polar(6.8, -120)}A6.8 6.8 0 1 0 ${polar(6.8, 60)}L${POKE_X} ${POKE_Y}Z" fill="#6F777C"/>
  <circle cx="${fmt(POKE_X * 0.55)}" cy="${fmt(POKE_Y * 0.55)}" r="6.1" fill="url(#slab-poke-cone)"/>
</svg>`;

/**
 * The winged knock-off on the poke's tip. Its ears are what the eye follows
 * when the wheel spins, so it carries the motion while the spokes blur.
 */
export const WHEEL_KNOCKOFF = `
<svg class="slab-wheel-knock" ${BOX}>
  <g transform="translate(${POKE_X} ${POKE_Y})">
    <path d="M-7.7 -2L-2.6 -1.45L2.6 -1.45L7.7 -2L7.7 2L2.6 1.45L-2.6 1.45L-7.7 2Z" fill="#F1F4F5" stroke="#16181A" stroke-width=".65" stroke-linejoin="round"/>
    <circle r="1.8" fill="#FFFFFF" stroke="#16181A" stroke-width=".55"/>
  </g>
</svg>`;

/**
 * The playbar chip: the same wheel face-on, drawn like the client's own line
 * icons, with nothing outside the tyre. Off, the band is plain; on, it is the
 * Vogue band, so "on" doesn't depend on colour alone.
 */
function chipIcon(): string {
    let spokes = "";
    for (let i = 0; i < 10; i++) spokes += `<path d="M${polar(5.0, i * 36 + 18, 10, 10)}L${polar(2.2, i * 36 + 18, 10, 10)}"/>`;
    return `
<svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true" focusable="false">
  <circle cx="10" cy="10" r="8.7" stroke="currentColor" stroke-width="1.8"/>
  <circle class="slab-chip-plain" cx="10" cy="10" r="6.4" stroke="currentColor" stroke-width="1"/>
  <g class="slab-chip-vogue"><circle cx="10" cy="10" r="7" stroke="#F4F0E6" stroke-width="1.3"/><circle cx="10" cy="10" r="5.9" stroke="#E2B53A" stroke-width=".8"/></g>
  <g stroke="currentColor" stroke-width="1" stroke-linecap="round">${spokes}</g>
  <path d="M6.4 9.2H13.6V10.8H6.4Z" fill="currentColor"/>
  <circle cx="10" cy="10" r="1.3" fill="currentColor"/>
</svg>`;
}

export const CHIP_ICON = chipIcon();

export const CLOSE_ICON = `
<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true" focusable="false">
  <path d="M1.5 1.5l9 9m0-9l-9 9" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
</svg>`;

/** A Phillips head, the cross slot GM used on its sill plates, left at whatever angle it stopped. */
function phillips(slot: number): string {
    return `<svg class="slab-screw" viewBox="-4 -4 8 8" width="8" height="8" aria-hidden="true" focusable="false">
  <circle r="3.7" fill="#4A4E52"/><circle r="3.1" fill="#C3C8CC"/><circle r="3.1" fill="none" stroke="#F2F4F5" stroke-width=".5" stroke-dasharray="4.9 14.6" transform="rotate(200)"/>
  <path d="M${polar(2.2, slot)}L${polar(2.2, slot + 180)}M${polar(2.2, slot + 90)}L${polar(2.2, slot + 270)}" stroke="#2B2D30" stroke-width=".9" stroke-linecap="round"/>
</svg>`;
}

export const SILL_SCREW_LEFT = phillips(28);
export const SILL_SCREW_RIGHT = phillips(71);
