/**
 * burnin.js - where the timecode line goes, so it is never cut off.
 *
 * Measured on Premiere 25.6.6 by rendering "Metadata & Timecode Burn-in" on
 * nests of three shapes (docs/API-FINDINGS.md §23):
 *
 *   frame        Size   box (w x h)   left edge
 *   1080x1920    25     708 x 95 px   0.381 - runs 40 px off the right edge
 *   1920x1080    25     708 x 95 px   0.380
 *   3840x2160    25     707 x 95 px   0.380
 *   1080x1920    8.44   237 x 31 px   0.381
 *
 * So the text is a FIXED PIXEL SIZE - about 28.4 px of box width per unit of
 * the effect-wide Size, whatever the frame - while Line 1's Position is a
 * FRACTION of the frame, measured to the box's LEFT edge. Adobe's default x of
 * 0.38 only happens to look central on a 1920-wide frame; on a 1080-wide 9x16
 * an 11-character timecode at Size 25 cannot fit from there.
 *
 * The layout centres the box on the actual frame width and only shrinks Size
 * when even a centred box would not fit inside the margins. Pure, so it is
 * tested without Premiere (tests/burnin-test.js).
 */

var BOX_PX_PER_SIZE = 28.4;  // box width per unit of effect-wide Size (fit of the four renders above)
var MARGIN = 0.05;           // keep 5% clear either side
var MIN_SIZE = 8;            // below this a timecode stops being readable on a viewing copy
var DEFAULT_Y = 0.93;        // Adobe's own Line 1 height, read back on 25.6.6; it never clips vertically

function round4(n) { return Math.round(n * 10000) / 10000; }

/**
 * Where Line 1 goes and how big it is, for a frame `frameWidth` pixels wide.
 * Returns { size, x, y, shrunk, boxWidthPx } - or { size, x: null } when the
 * width is unknown, meaning "leave Adobe's position alone".
 */
function burnInLayout(frameWidth, wantedSize) {
  var size = wantedSize == null ? 25 : Number(wantedSize);
  var w = Number(frameWidth);
  if (!(w > 0) || !(size > 0)) return { size: size, x: null, y: null, shrunk: false, boxWidthPx: null };

  var maxBox = w * (1 - 2 * MARGIN);
  var shrunk = false;
  if (size * BOX_PX_PER_SIZE > maxBox) {
    size = Math.max(MIN_SIZE, Math.floor(maxBox / BOX_PX_PER_SIZE));
    shrunk = true;
  }
  var box = size * BOX_PX_PER_SIZE;
  var x = Math.max(0, 0.5 - box / (2 * w));
  return { size: size, x: round4(x), y: DEFAULT_Y, shrunk: shrunk, boxWidthPx: Math.round(box) };
}

module.exports = { burnInLayout: burnInLayout, BOX_PX_PER_SIZE: BOX_PX_PER_SIZE, MARGIN: MARGIN, MIN_SIZE: MIN_SIZE, DEFAULT_Y: DEFAULT_Y };
