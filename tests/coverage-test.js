/**
 * Tests for the hidden-clip coverage logic in js/ppro.js.
 *
 * This decides whether a clip gets DELETED, so it is the most dangerous logic
 * in the panel. A false "full" removes a shot that was on screen. Everything
 * here is pure arithmetic, so it is tested properly rather than in Premiere.
 *
 * Times are in ticks in the real code; plain numbers here.
 */

var module = { exports: {} };
(new Function("module", "exports", "require", readFile("js/ppro.js")))(
  module, module.exports, function (name) { throw new Error("no host module: " + name); }
);
var P = module.exports;

var passed = 0, failed = 0;
function eq(actual, expected, label) {
  var a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) passed++;
  else { failed++; print("FAIL  " + label + "\n      expected " + e + "\n      got      " + a); }
}

// --- mergeIntervals --------------------------------------------------------

eq(P.mergeIntervals([]), [], "no intervals");
eq(P.mergeIntervals([{ start: 0, end: 10 }]), [{ start: 0, end: 10 }], "one interval");
eq(P.mergeIntervals([{ start: 0, end: 5 }, { start: 5, end: 10 }]),
   [{ start: 0, end: 10 }], "touching intervals merge");
eq(P.mergeIntervals([{ start: 0, end: 6 }, { start: 4, end: 10 }]),
   [{ start: 0, end: 10 }], "overlapping intervals merge");
eq(P.mergeIntervals([{ start: 5, end: 10 }, { start: 0, end: 3 }]),
   [{ start: 0, end: 3 }, { start: 5, end: 10 }], "disjoint stay separate and sort");
eq(P.mergeIntervals([{ start: 0, end: 10 }, { start: 2, end: 4 }]),
   [{ start: 0, end: 10 }], "a contained interval is absorbed");

// --- coverage --------------------------------------------------------------

var span = { start: 10, end: 20 };

eq(P.coverage(span, []), "none", "nothing above means nothing covered");
eq(P.coverage(span, [{ start: 0, end: 5 }]), "none", "an interval that ends before the clip");
eq(P.coverage(span, [{ start: 30, end: 40 }]), "none", "an interval that starts after the clip");

eq(P.coverage(span, [{ start: 10, end: 20 }]), "full", "exactly covering");
eq(P.coverage(span, [{ start: 0, end: 30 }]), "full", "more than covering");
eq(P.coverage(span, [{ start: 10, end: 15 }, { start: 15, end: 20 }]), "full",
   "two abutting intervals cover it");

eq(P.coverage(span, [{ start: 10, end: 15 }]), "partial", "covers the front only");
eq(P.coverage(span, [{ start: 15, end: 20 }]), "partial", "covers the tail only");
eq(P.coverage(span, [{ start: 12, end: 18 }]), "partial", "covers the middle only");

// The case that matters most: a gap in the middle must NOT read as full.
eq(P.coverage(span, [{ start: 10, end: 14 }, { start: 16, end: 20 }]), "partial",
   "a hole in the middle is partial, never full");

// Edges: touching but not overlapping is not coverage.
eq(P.coverage(span, [{ start: 0, end: 10 }]), "none",
   "an interval ending exactly at the clip start does not cover it");
eq(P.coverage(span, [{ start: 20, end: 30 }]), "none",
   "an interval starting exactly at the clip end does not cover it");

// A one-frame clip.
eq(P.coverage({ start: 100, end: 101 }, [{ start: 100, end: 101 }]), "full",
   "a single-frame clip can be fully covered");
eq(P.coverage({ start: 100, end: 101 }, [{ start: 101, end: 200 }]), "none",
   "a single-frame clip abutting the next is not covered");

// Real shape from the test teaser: three clips stacked at the head.
// V1 0-0.76 and V2 0-0.76 sit under V3 0-0.76, so both are fully hidden.
var teaserTop = [{ start: 0, end: 76 }];
eq(P.coverage({ start: 0, end: 76 }, teaserTop), "full", "teaser head: V1 clip is hidden");

// V6 clip 1.44-2.84 only partly overlaps V1's 2.2-6.32 - must be kept.
eq(P.coverage({ start: 220, end: 632 }, P.mergeIntervals([{ start: 144, end: 284 }])), "partial",
   "teaser: a clip only partly overlapped is partial, so it survives");

// Many small intervals adding up to full cover.
var many = [];
for (var i = 0; i < 50; i++) many.push({ start: i * 2, end: (i + 1) * 2 });
eq(P.coverage({ start: 0, end: 100 }, P.mergeIntervals(many)), "full",
   "fifty abutting intervals cover the span");
many.splice(25, 1);
eq(P.coverage({ start: 0, end: 100 }, P.mergeIntervals(many)), "partial",
   "removing one of them leaves a hole, so it is partial");

// Unsorted input must not fool it.
eq(P.coverage(span, P.mergeIntervals([{ start: 15, end: 20 }, { start: 10, end: 15 }])), "full",
   "unsorted intervals still merge to full cover");

print("");
print(passed + " passed, " + failed + " failed");
if (failed > 0) throw new Error(failed + " test(s) failed");
