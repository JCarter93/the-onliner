/**
 * Guards the one Premiere rule that no unit test can reach.
 *
 * Component and parameter actions must be CREATED inside
 * `project.lockedAccess(...)`, not merely executed there. Created outside, they
 * throw "The script object is no longer valid" every time.
 *
 * This is invisible to normal testing: the code reads fine, the transaction
 * still looks well-formed, and the failure only appears against a live
 * Premiere. It shipped once already - the burn-in path failed while the plain
 * export worked, because only the burn-in touches a component chain - so it is
 * enforced structurally here instead.
 */

/**
 * EVERY create*Action call, not just the component ones.
 *
 * The rule was first found on component chains, so this guard was originally
 * scoped to those - and promptly missed five more instances in the Phase 3
 * code: createCloneAction, createSetNameAction, createBinAction,
 * createSetColorLabelAction and createAddMarkerAction were all being created
 * outside lockedAccess. createCloneAction failed exactly the same way. Scope it
 * to the whole family so a new action type cannot slip through.
 */
var ACTION_CALL = /create[A-Z][A-Za-z0-9]*Action\s*\(/g;

var passed = 0, failed = 0;

function ok(cond, label) {
  if (cond) passed++;
  else { failed++; print("FAIL  " + label); }
}

/** Blank out comments and string bodies so they cannot fake a match. */
function stripNoise(src) {
  var out = src.split("");
  var i = 0, n = src.length;
  var blank = function (from, to) {
    for (var k = from; k < to && k < n; k++) if (out[k] !== "\n") out[k] = " ";
  };
  while (i < n) {
    var two = src.substr(i, 2);
    if (two === "/*") {
      var end = src.indexOf("*/", i + 2);
      if (end === -1) end = n;
      blank(i, end + 2); i = end + 2; continue;
    }
    if (two === "//") {
      var nl = src.indexOf("\n", i);
      if (nl === -1) nl = n;
      blank(i, nl); i = nl; continue;
    }
    var ch = src[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      var j = i + 1;
      while (j < n && src[j] !== ch) { if (src[j] === "\\") j++; j++; }
      blank(i, j + 1); i = j + 1; continue;
    }
    i++;
  }
  return out.join("");
}

/** [start,end) spans of every lockedAccess( ... ) call, by brace/paren matching. */
function lockedSpans(src) {
  var spans = [];
  var idx = src.indexOf("lockedAccess(");
  while (idx !== -1) {
    var open = src.indexOf("(", idx);
    var depth = 0, k = open;
    for (; k < src.length; k++) {
      if (src[k] === "(") depth++;
      else if (src[k] === ")") { depth--; if (depth === 0) { k++; break; } }
    }
    spans.push([idx, k]);
    idx = src.indexOf("lockedAccess(", k);
  }
  return spans;
}

function lineOf(src, index) {
  return src.slice(0, index).split("\n").length;
}

var raw = readFile("js/ppro.js");
var src = stripNoise(raw);
var spans = lockedSpans(src);

ok(spans.length > 0, "ppro.js uses lockedAccess at all");

var checked = 0;
var m;
ACTION_CALL.lastIndex = 0;
while ((m = ACTION_CALL.exec(src)) !== null) {
  checked++;
  var at = m.index;
  var inside = spans.some(function (s) { return at >= s[0] && at < s[1]; });
  ok(inside, m[0].replace(/\s*\($/, "") + " at js/ppro.js:" + lineOf(src, at) +
     " must be created inside project.lockedAccess(...)");
}

ok(checked > 0, "found component/param actions to check (the guard is live)");

/**
 * Values handed to an action must be built inside lockedAccess too.
 *
 * A PointF constructed outside and used inside dies exactly like a stale handle
 * or a prematurely-created action - the third variant of one rule, and the one
 * that got through both earlier versions of this guard because it is not an
 * action call at all. Motion reset failed on every clip because of it.
 */
var VALUE_BUILDERS = [/\bnew\s+P?\.?PointF\s*\(/g, /\bmotionDefaultValue\s*\(/g];

/**
 * The body of motionDefaultValue is exempt: it is the helper that builds the
 * value, and it is CALLED from inside lockedAccess. Its own `new PointF` is
 * correct where it is. Exempt the function body, not the pattern - weakening
 * the pattern would stop catching a direct `new PointF` written outside.
 */
var helperSpan = (function () {
  var at = src.indexOf("function motionDefaultValue");
  if (at === -1) return null;
  var open = src.indexOf("{", at), depth = 0, k = open;
  for (; k < src.length; k++) {
    if (src[k] === "{") depth++;
    else if (src[k] === "}") { depth--; if (depth === 0) { k++; break; } }
  }
  return [at, k];
})();
ok(helperSpan !== null, "found the motionDefaultValue helper to exempt");

var valueSites = 0;
VALUE_BUILDERS.forEach(function (re) {
  re.lastIndex = 0;
  var v;
  while ((v = re.exec(src)) !== null) {
    if (helperSpan && v.index >= helperSpan[0] && v.index < helperSpan[1]) continue;
    valueSites++;
    var at = v.index;
    var inside = spans.some(function (s2) { return at >= s2[0] && at < s2[1]; });
    ok(inside, v[0].replace(/\s*\($/, "") + " at js/ppro.js:" + lineOf(src, at) +
       " must be built inside project.lockedAccess(...) - a value built outside goes stale");
  }
});
ok(valueSites > 0, "found action-value builders to check");

/**
 * Every stage of the grade pipeline must re-resolve its Sequence by GUID.
 *
 * A Sequence object does not survive being carried across stages. Held from the
 * clone through strip/remove/flatten and handed to the clip walk, it goes stale
 * and everything after it dies as "The script object is no longer valid" - a run
 * flattened 12 clips successfully and then failed on the very next call. The
 * pipeline passes GUID strings; each function calls resolveSequence at entry.
 */
var PIPELINE = [
  "renameSequence", "stripAudioClips", "removeDisabledClips",
  "removeAdjustmentLayers", "removeHiddenClips", "flattenToSingleTrack",
  "processGradeClips", "fileSequence", "writeRunManifest"
];

function bodyOf(name) {
  var at = src.indexOf("function " + name + "(");
  if (at === -1) return null;
  var open = src.indexOf("{", at), depth = 0, k = open;
  for (; k < src.length; k++) {
    if (src[k] === "{") depth++;
    else if (src[k] === "}") { depth--; if (depth === 0) { k++; break; } }
  }
  return src.slice(at, k);
}

PIPELINE.forEach(function (name) {
  var body = bodyOf(name);
  ok(body !== null, name + " exists in ppro.js");
  if (!body) return;
  ok(/await\s+resolveSequence\s*\(/.test(body),
     name + " must re-resolve its Sequence with resolveSequence(...) - a Sequence " +
     "carried in from a previous stage is stale");
  ok(!/^async function [a-zA-Z]+\(\s*sequence\s*[,)]/.test(body),
     name + " should take a GUID (sequenceRef), not a Sequence object");
});

print("");
print(passed + " passed, " + failed + " failed  (" + checked + " action call sites checked)");
if (failed > 0) throw new Error(failed + " test(s) failed");
