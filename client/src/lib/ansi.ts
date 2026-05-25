/**
 * Last-line-of-defense ANSI/escape sanitizer for terminal chunks.
 * Mirrors the server-side stripper. Cheap (single regex pass).
 *
 * Removes: OSC, DCS, APC, PM, SOS sequences (complete ones only) and lone BEL bytes.
 * Keeps: CSI (`ESC [ ... <final>`) for colors / cursor; raw text and standard control chars.
 *
 * Partial sequences at chunk boundaries are left intact — xterm.js's state machine handles
 * cross-chunk reassembly itself.
 */
const STRIP_RE = new RegExp(
  [
    // OSC: ESC ] ... (BEL | ESC \)
    '\\x1b\\][\\s\\S]*?(?:\\x07|\\x1b\\\\)',
    // DCS / APC / PM / SOS: ESC (P|_|^|X) ... ESC \
    '\\x1b[P_\\^X][\\s\\S]*?\\x1b\\\\',
    // Lone BEL
    '\\x07',
  ].join('|'),
  'g',
);

export function stripNoise(s: string): string {
  return s.replace(STRIP_RE, '');
}
