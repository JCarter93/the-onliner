/**
 * Tests for js/fcpxml.js - stripping empty tracks out of the exported XML.
 *
 * This edits a deliverable that a colourist conforms from, by scanning text
 * rather than parsing XML, so it is tested hard. The property that matters
 * most: a clip must never be lost.
 */

var module = { exports: {} };
(new Function("module", "exports", "require", readFile("js/fcpxml.js")))(
  module, module.exports, function (n) { throw new Error("no module " + n); }
);
var F = module.exports;

var passed = 0, failed = 0;
function ok(cond, label) { if (cond) passed++; else { failed++; print("FAIL  " + label); } }
function eq(a, e, label) {
  var A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) passed++; else { failed++; print("FAIL  " + label + "\n      expected " + E + "\n      got      " + A); }
}
function throws(fn, label) {
  try { fn(); failed++; print("FAIL  " + label + " (expected a throw)"); }
  catch (e) { passed++; }
}

function track(clips) {
  var body = "<enabled>TRUE</enabled><locked>FALSE</locked>";
  for (var i = 0; i < clips; i++) {
    body += '<clipitem id="c' + i + '"><name>shot' + i + '</name><start>' + (i * 10) + '</start></clipitem>';
  }
  return "\n\t\t\t<track>" + body + "</track>";
}
function doc(videoTracks, audioTracks) {
  var v = "", a = "";
  videoTracks.forEach(function (n) { v += track(n); });
  audioTracks.forEach(function (n) { a += track(n); });
  return '<?xml version="1.0"?>\n<xmeml version="4">\n<sequence><name>Test</name><media>' +
         "\n\t\t<video>" + v + "\n\t\t</video>" +
         "\n\t\t<audio>" + a + "\n\t\t</audio>" +
         "</media></sequence>\n</xmeml>\n";
}

// --- the real shape: one populated video track, everything else empty -------

var r = F.stripEmptyTracks(doc([29, 0, 0, 0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0]));
eq(r.removed, 14, "removes 9 empty video tracks and 5 empty audio tracks");
eq(r.keptWithClips, 1, "keeps the one track that has clips");
eq(r.clipitemsBefore, 29, "counted the clips before");
eq(r.clipitemsAfter, 29, "every clip survived");
ok(r.xml.indexOf("<clipitem") !== -1, "clips are still in the output");
eq((r.xml.match(/<track>/g) || []).length, 1, "exactly one track remains");

// --- nothing to do ---------------------------------------------------------

var full = F.stripEmptyTracks(doc([3, 2], [4]));
eq(full.removed, 0, "no empty tracks means nothing is removed");
eq(full.keptWithClips, 3, "all three populated tracks kept");
eq(full.clipitemsAfter, 9, "clip count unchanged");

// --- everything empty ------------------------------------------------------

var none = F.stripEmptyTracks(doc([0, 0], [0]));
eq(none.removed, 3, "all-empty removes every track");
eq(none.clipitemsAfter, 0, "no clips to lose");
ok(none.xml.indexOf("<video>") !== -1, "the video element itself is not removed");
ok(none.xml.indexOf("<audio>") !== -1, "the audio element itself is not removed");

// --- layer order is preserved ----------------------------------------------

var ordered = F.stripEmptyTracks(
  '<media><video>' + "\n<track><clipitem id=\"c0\"><name>BOTTOM</name></clipitem></track>" +
  "\n<track><enabled>TRUE</enabled></track>" +
  "\n<track><clipitem id=\"c1\"><name>TOP</name></clipitem></track>" + "\n</video></media>");
eq(ordered.removed, 1, "the empty track between two populated ones is removed");
ok(ordered.xml.indexOf("BOTTOM") < ordered.xml.indexOf("TOP"),
   "the populated tracks keep their relative order, so layering is unchanged");

// --- a nested sequence's own empty tracks ----------------------------------

var nested = F.stripEmptyTracks(
  "<media><video><track><clipitem id=\"c0\"><name>nest</name>" +
  "<sequence><media><video><track><enabled>TRUE</enabled></track></media></video></sequence>" +
  "</clipitem></track><track><enabled>TRUE</enabled></track></video></media>");
eq(nested.clipitemsAfter, nested.clipitemsBefore, "a nested sequence does not confuse the count");
ok(nested.removed >= 1, "the outer empty track is still removed");

// --- the safety net --------------------------------------------------------

// A doctored module whose scan would drop a clip must refuse rather than write.
var sabotaged = { exports: {} };
var src = readFile("js/fcpxml.js").replace(
  'if (body.indexOf("<clipitem") === -1) {', 'if (true) {');
(new Function("module", "exports", "require", src))(sabotaged, sabotaged.exports, function () {});
throws(function () { sabotaged.exports.stripEmptyTracks(doc([5], [0])); },
       "a scan that would lose clips throws instead of returning a short XML");

// --- odd input -------------------------------------------------------------

eq(F.stripEmptyTracks("").removed, 0, "empty string is handled");
eq(F.stripEmptyTracks(null).clipitemsAfter, 0, "null is handled");
ok(F.stripEmptyTracks("<trackinfo>not a track</trackinfo>").removed === 0,
   "an element merely starting with 'track' is not treated as a track");

var unclosed = F.stripEmptyTracks("<video><track><enabled>TRUE</enabled></video>");
eq(unclosed.clipitemsAfter, unclosed.clipitemsBefore, "an unclosed track does not lose clips");

// --- whitespace ------------------------------------------------------------

ok(F.stripEmptyTracks(doc([1, 0], [])).xml.indexOf("\n\n\n") === -1,
   "removed tracks do not leave runs of blank lines");

// --- Premiere's translation report ----------------------------------------

// Verbatim from a real export, BOM and tab included.
var REAL = "\uFEFFTranslation issue:\n\tSequence <MyFilm_TEASER_V6_FOR_GRADE_v05> at , video track 1: Effect <Warp Stabilizer> on Clip <C006R029_260310KZ> not translated.\n";

var msgs = F.parseTranslationReport(REAL);
eq(msgs.length, 1, "one issue parsed from the real report");
ok(msgs[0].indexOf("Warp Stabilizer") !== -1, "the message names the effect");
ok(msgs[0].indexOf("C006R029_260310KZ") !== -1, "the message names the clip");
ok(F.parseTranslationReport(REAL)[0].charAt(0) !== "\uFEFF", "the BOM is stripped");

var TWO = "Translation issue:\n\tSynthetic Item (Black Video) not translated, Slug used as a placeholder.\n" +
          "Translation issue:\n\tSequence <X> at , video track 2: Effect <Warp Stabilizer> on Clip <C1> not translated.\n";
eq(F.parseTranslationReport(TWO).length, 2, "two issues parsed");
ok(F.parseTranslationReport(TWO)[0].indexOf("Black Video") !== -1, "the first issue is the slug");

// Premiere repeats the same issue once per affected clip instance; the panel
// should not print the identical line five times.
var DUPES = "Translation issue:\n\tSame problem.\nTranslation issue:\n\tSame problem.\nTranslation issue:\n\tSame problem.\n";
eq(F.parseTranslationReport(DUPES).length, 1, "identical messages are de-duplicated");

eq(F.parseTranslationReport(""), [], "an empty report yields no issues");
eq(F.parseTranslationReport("nothing of interest here"), [], "unrelated text yields no issues");
eq(F.parseTranslationReport("Translation issue:\n"), [], "a header with no message is ignored");
eq(F.parseTranslationReport("Translation issue:\n\nTranslation issue:\n\tReal one.\n").length, 1,
   "a blank line does not swallow the following issue");

// Tidying: the "Sequence <...> at ," prefix is noise in a panel already showing
// the sequence name.
eq(F.tidyTranslationMessage("Sequence <MyEdit_FOR_GRADE> at , video track 1: Effect <Warp Stabilizer> on Clip <C1> not translated."),
   "video track 1: Effect <Warp Stabilizer> on Clip <C1> not translated.",
   "the sequence prefix is trimmed");
eq(F.tidyTranslationMessage("Synthetic Item (Black Video) not translated, Slug used as a placeholder."),
   "Synthetic Item (Black Video) not translated, Slug used as a placeholder.",
   "a message with no prefix is unchanged");

print("");
print(passed + " passed, " + failed + " failed");
if (failed > 0) throw new Error(failed + " test(s) failed");
