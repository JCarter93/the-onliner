/**
 * Tests for js/burnin.js - where the timecode line goes so it is never cut off.
 *
 * The constants come from real renders on Premiere 25.6.6 (docs/API-FINDINGS.md
 * §23): the box is a fixed ~28.4 px wide per unit of Size on every frame shape,
 * and Line 1's Position is a fraction of the frame measured to the box's left
 * edge. The 1080x1920 and 1920x1080 layouts below were rendered and measured:
 * boxes at 185-893 px and 605-1313 px, centred and whole.
 */

var module = { exports: {} };
(new Function("module", "exports", "require", readFile("js/burnin.js")))(
  module, module.exports, function (name) { throw new Error("no host module: " + name); });
var B = module.exports;

var passed = 0, failed = 0;
function eq(actual, expected, label) {
  var a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) passed++;
  else { failed++; print("FAIL  " + label + "\n      expected " + e + "\n      got      " + a); }
}
function ok(cond, label) { if (cond) passed++; else { failed++; print("FAIL  " + label); } }

function rightEdgePx(l, w) { return l.x * w + l.boxWidthPx; }

// --- the bug: Adobe's default x on a 9x16 -----------------------------------
ok(0.38 * 1080 + 25 * B.BOX_PX_PER_SIZE > 1080, "the default x of 0.38 really does overflow a 1080-wide frame at Size 25");

var p = B.burnInLayout(1080, 25);
eq([p.size, p.x, p.shrunk], [25, 0.1713, false], "9x16 1080: Size kept, centred - rendered as 185-893 px");
ok(rightEdgePx(p, 1080) <= 1080, "9x16 1080: nothing past the right edge");
eq(B.burnInLayout(1920, 25).x, 0.3151, "16:9 1920: centred - rendered as 605-1313 px");
eq(B.burnInLayout(3840, 25).x, 0.4076, "UHD: centred, same pixel size as on HD");

// --- too narrow to fit: shrink, still centred -------------------------------
var n = B.burnInLayout(720, 25);
ok(n.shrunk && n.size < 25, "720 wide: Size shrinks rather than overflow");
ok(n.boxWidthPx <= 720 * (1 - 2 * B.MARGIN), "720 wide: the shrunk box fits inside the margins");
ok(Math.abs((n.x * 720 + n.boxWidthPx / 2) - 360) < 1, "720 wide: and is centred");
eq(B.burnInLayout(100, 25).size, B.MIN_SIZE, "absurdly narrow: never below the readable minimum");
ok(B.burnInLayout(100, 25).x >= 0, "and never a negative position");

// --- a smaller asked-for size is honoured -----------------------------------
eq(B.burnInLayout(1080, 15).size, 15, "a size that fits is never changed");
ok(B.burnInLayout(1080, 15).x > p.x, "a smaller box sits further in");

// --- unknown frame: leave Adobe alone ---------------------------------------
eq(B.burnInLayout(null, 25), { size: 25, x: null, y: null, shrunk: false, boxWidthPx: null },
   "no frame width (a build without getFrameSize) means no Position write");
eq(B.burnInLayout(0, 25).x, null, "zero width is unknown, not a division by zero");
eq(B.burnInLayout(1080).size, 25, "Size defaults to the panel's 25");
eq(p.y, 0.93, "y stays at Adobe's own line height");

print((failed ? "FAILED " : "ok ") + passed + " passed, " + failed + " failed");
if (failed) throw new Error(failed + " failed");
