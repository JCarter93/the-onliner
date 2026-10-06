/**
 * Phase 1 test: the reveal/disable behaviour in every toggle combination, and
 * suffix persistence between runs.
 *
 * The panel cannot be clicked from outside Premiere, so this loads the real
 * js/app.js against a mock DOM and a mock localStorage and drives its actual
 * state. It is the same code path the panel runs - not a reimplementation.
 *
 * Run with scripts/run-tests.sh.
 */

var passed = 0, failed = 0;

function ok(cond, label) {
  if (cond) passed++;
  else { failed++; print("FAIL  " + label); }
}
function eq(actual, expected, label) {
  var a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) passed++;
  else { failed++; print("FAIL  " + label + "\n      expected " + e + "\n      got      " + a); }
}

// --- mock DOM --------------------------------------------------------------

function El(id) {
  this.id = id;
  this._classes = {};
  this.hidden = false;
  this.disabled = false;
  this.checked = false;
  this.selected = undefined;
  this.value = "";
  this.textContent = "";
  this.innerHTML = "";
  this.className = "";
  this.title = "";
  this.children = [];
  var self = this;
  this.classList = {
    toggle: function (name, force) {
      var on = (arguments.length > 1) ? !!force : !self._classes[name];
      if (on) self._classes[name] = true; else delete self._classes[name];
      return on;
    },
    contains: function (name) { return !!self._classes[name]; },
    add: function (name) { self._classes[name] = true; },
    remove: function (name) { delete self._classes[name]; }
  };
  this.addEventListener = function () {};
  this.appendChild = function (child) { self.children.push(child); return child; };
}

var ELS = {};
globalThis.document = {
  getElementById: function (id) {
    if (!ELS[id]) ELS[id] = new El(id);
    return ELS[id];
  },
  createElement: function (tag) { return new El("<" + tag + ">"); }
};

// --- mock localStorage -----------------------------------------------------

var STORE = {};
globalThis.localStorage = {
  getItem: function (k) { return Object.prototype.hasOwnProperty.call(STORE, k) ? STORE[k] : null; },
  setItem: function (k, v) { STORE[k] = String(v); },
  removeItem: function (k) { delete STORE[k]; }
};

// --- module loader + require shim -----------------------------------------

var LOADED = {};

/**
 * Each file gets its own scope, the way UXP's loader gives it one. jsc's
 * load() would evaluate them all in the shared global instead, where app.js's
 * `const ppro = require(...)` collides with ppro.js's own `function ppro()`
 * and nothing loads at all.
 */
function loadModule(path, key) {
  var module = { exports: {} };
  var fn = new Function("module", "exports", "require", readFile(path));
  fn(module, module.exports, globalThis.require);
  if (key) LOADED[key] = module.exports;
  return module.exports;
}

globalThis.require = function (name) {
  if (LOADED[name]) return LOADED[name];
  // A module inside js/ may ask for a sibling as "./x" (folder-relative) or
  // "./js/x" (root-relative); the real loaders differ, so both are honoured.
  if (LOADED["./js/" + name.replace(/^\.\//, "")]) return LOADED["./js/" + name.replace(/^\.\//, "")];
  // ppro.js asks for these lazily; outside Premiere there is no host module,
  // and isAvailable() is written to treat the throw as "not available".
  if (name === "premierepro" || name === "uxp" || name === "os" || name === "fs") {
    throw new Error("Host module '" + name + "' is not available outside Premiere.");
  }
  throw new Error("Unexpected require: " + name);
};

loadModule("js/prefs.js", "./js/prefs");
loadModule("js/platform.js", "./js/platform");   // presets.js and app.js require it
loadModule("js/presets.js", "./js/presets");
loadModule("js/fcpxml.js", "./js/fcpxml");
loadModule("js/naming.js", "./js/naming");
loadModule("js/ppro.js", "./js/ppro");

var prefs = LOADED["./js/prefs"];
var naming = LOADED["./js/naming"];

// app.js runs boot() on load. Outside Premiere ppro.isAvailable() is false, so
// boot settles without touching the host.
var app = loadModule("js/app.js");

// ---------------------------------------------------------------------------
// The reveal / disable matrix - all eight combinations
// ---------------------------------------------------------------------------

function setToggles(ref, grade, mix) {
  app.state.settings.refEnabled = ref;
  app.state.settings.gradeEnabled = grade;
  app.state.settings.mixEnabled = mix;
  app.applyToggleState();
}

var combos = [
  [false, false, false], [true, false, false], [false, true, false], [false, false, true],
  [true, true, false], [true, false, true], [false, true, true], [true, true, true]
];

app.state.caps = null;      // capability gating tested separately
app.state.sourceId = "seq-1";
app.state.sequences = [{ id: "seq-1", name: "MyEdit" }];
// A destination is a precondition for processing, tested on its own below.
// Set here so the matrix isolates the toggle rules.
app.state.refFolder = { path: "/tmp/refs" };
app.state.gradeFolder = { path: "/tmp/grade" };
app.state.mixFolder = { path: "/tmp/mix" };

combos.forEach(function (c) {
  var ref = c[0], grade = c[1], mix = c[2];
  var label = "[ref=" + ref + " grade=" + grade + " mix=" + mix + "] ";
  setToggles(ref, grade, mix);

  // Reference: sub-options stay VISIBLE and grey out. The spec asks for
  // "disabled/greyed until the parent is checked", not hidden.
  ok(ELS.refBody.hidden === false, label + "reference sub-options are never hidden");
  eq(ELS.refBody.classList.contains("disabled"), !ref, label + "reference sub-options greyed iff off");

  // Grade and Mix: the body is REVEALED by the toggle.
  eq(ELS.gradeBody.hidden, !grade, label + "grade body revealed iff on");
  eq(ELS.mixBody.hidden, !mix, label + "mix body revealed iff on");

  // Independence: one section's state must not leak into another's.
  eq(ELS.secRef.classList.contains("on"), ref, label + "ref section marker");
  eq(ELS.secGrade.classList.contains("on"), grade, label + "grade section marker");
  eq(ELS.secMix.classList.contains("on"), mix, label + "mix section marker");

  // Buttons: enabled only when there is something to do.
  var any = ref || grade || mix;
  eq(ELS.btnAnalyse.disabled, !any, label + "analyse button enabled iff a section is on");
  eq(ELS.btnProcess.disabled, !any, label + "process button enabled iff a section is on");
});

// No source sequence: buttons must be dead even with sections enabled.
app.state.sourceId = null;
setToggles(true, true, true);
ok(ELS.btnAnalyse.disabled === true, "analyse disabled with no source sequence");
ok(ELS.btnProcess.disabled === true, "process disabled with no source sequence");
app.state.sourceId = "seq-1";

// A reference export with nowhere to write to must not be startable. Analysis
// stays available - it writes nothing, so it is always safe to run.
app.state.refFolder = null;
setToggles(true, false, false);
ok(ELS.btnProcess.disabled === true, "process blocked when reference has no destination folder");
ok(ELS.btnAnalyse.disabled === false, "analysis still allowed with no destination folder");

setToggles(false, true, true);
ok(ELS.btnProcess.disabled === false,
   "grade and mix do not need the reference destination folder");

// Mix's AAF needs its own destination, and only when the export is on.
app.state.mixFolder = null;
app.state.settings.mixExportAAF = true;
setToggles(false, false, true);
ok(ELS.btnProcess.disabled === true, "process blocked when the AAF has no destination");
ok(/AAF/i.test(ELS.blockHint.textContent), "the blocked reason names the AAF destination");

app.state.settings.mixExportAAF = false;
setToggles(false, false, true);
ok(ELS.btnProcess.disabled === false, "mix with no AAF export needs no destination folder");
app.state.settings.mixExportAAF = true;
app.state.mixFolder = { path: "/tmp/mix" };

// Flatten + adjustment layers is the combination that emptied a timeline in
// testing (37 clips down to 3). It must be unreachable, and must say why.
app.state.settings.gradeFlatten = true;
app.state.settings.gradeRemoveAdjustment = false;
setToggles(false, true, false);
ok(ELS.btnProcess.disabled === true,
   "process blocked when flattening with adjustment layers left in");
ok(/adjustment layer/i.test(ELS.blockHint.textContent),
   "the blocked reason names the adjustment layers");
ok(/empty the timeline/i.test(ELS.blockHint.textContent),
   "the blocked reason says what would happen, not just what is wrong");

app.state.settings.gradeRemoveAdjustment = true;
setToggles(false, true, false);
ok(ELS.btnProcess.disabled === false,
   "flattening is allowed once adjustment layers are being removed");

app.state.settings.gradeFlatten = false;
app.state.settings.gradeRemoveAdjustment = false;
setToggles(false, true, false);
ok(ELS.btnProcess.disabled === false,
   "keeping adjustment layers is fine when not flattening");
app.state.settings.gradeRemoveAdjustment = true;

// The AAF settings mirror Premiere's dialog, and Handle Frames follows Render
// exactly as Premiere greys it.
app.state.settings.mixExportAAF = true;
app.state.settings.aafRender = "copy";
setToggles(false, false, true);
ok(ELS.aafHandleFrames.disabled === true, "Handle Frames is disabled when copying complete files");
ok(/Trim Audio Files/i.test(ELS.aafHandleNote.textContent), "and says when it would apply");

app.state.settings.aafRender = "trim";
setToggles(false, false, true);
ok(ELS.aafHandleFrames.disabled === false, "Handle Frames is enabled when trimming");

app.state.settings.aafRender = "copy";
app.state.settings.mixExportAAF = false;
setToggles(false, false, true);
ok(ELS.aafSettings.classList.contains("disabled"),
   "the AAF settings grey out when the AAF export is off");
app.state.settings.mixExportAAF = true;

// The effects radio no longer offers "Render and Replace" - that is the AAF's
// own "Render audio clip effects", so it lives in one place only.
app.state.settings.mixEffects = "keep";
setToggles(false, false, true);
ok(/Render audio clip effects/i.test(ELS.mixEffectsNote.textContent),
   "the keep note points at the AAF setting that bakes effects");

// Grade's FCPXML needs its own destination - and only when the export is on.
app.state.gradeFolder = null;
app.state.settings.gradeExportXML = true;
setToggles(false, true, false);
ok(ELS.btnProcess.disabled === true, "process blocked when the FCPXML has no destination");
ok(/FCPXML/i.test(ELS.blockHint.textContent), "the blocked reason names the FCPXML destination");

app.state.settings.gradeExportXML = false;
setToggles(false, true, false);
ok(ELS.btnProcess.disabled === false,
   "grade with no FCPXML export needs no destination folder");
app.state.settings.gradeExportXML = true;
app.state.gradeFolder = { path: "/tmp/grade" };

app.state.refFolder = { path: "/tmp/refs" };
setToggles(true, false, false);
ok(ELS.btnProcess.disabled === false, "process allowed once a destination folder is set");

// Every blocked state must SAY why - a dead button with no explanation is
// indistinguishable from a broken panel, which is exactly how it was reported.
app.state.refFolder = null;
setToggles(true, false, false);
ok(ELS.btnProcess.disabled === true, "process blocked without a destination");
ok(/destination/i.test(ELS.blockHint.textContent),
   "the blocked reason names the missing destination");
ok(ELS.blockHint.hidden === false, "the blocked reason is visible");

setToggles(false, false, false);
ok(/switch on/i.test(ELS.blockHint.textContent),
   "with nothing enabled the hint says to enable a section");

app.state.refFolder = { path: "/tmp/refs" };
setToggles(true, false, false);
ok(ELS.blockHint.textContent === "", "the hint clears once the run is possible");
ok(ELS.blockHint.hidden === true, "the hint hides once the run is possible");

app.state.sourceId = null;
setToggles(true, false, false);
ok(/source sequence/i.test(ELS.blockHint.textContent),
   "a missing source sequence is named as the blocker");
app.state.sourceId = "seq-1";

// Busy: no double-firing a run.
app.state.busy = true;
setToggles(true, true, true);
ok(ELS.btnAnalyse.disabled === true, "analyse disabled while busy");
app.state.busy = false;

// ---------------------------------------------------------------------------
// Capability gating - options that would silently do nothing are switched off
// ---------------------------------------------------------------------------

app.state.caps = { exportAAF: false, exportFCPXML: false, timecodeFilter: null };
setToggles(true, true, true);
ok(ELS.mixExportAAF.disabled === true && ELS.mixExportAAF.checked === false,
   "AAF export disabled and unticked when the host cannot export AAF");
ok(ELS.gradeExportXML.disabled === true && ELS.gradeExportXML.checked === false,
   "FCPXML export disabled and unticked when the host cannot export it");
ok(ELS.refBurnIn.disabled === true && ELS.refBurnIn.checked === false,
   "burn-in disabled and unticked when the filter is missing");

app.state.caps = {
  exportAAF: true, exportFCPXML: true,
  timecodeFilter: { matchName: "AE.ADBE PPro Metadata" }
};
setToggles(true, true, true);
ok(ELS.mixExportAAF.disabled !== true, "AAF export left alone when the host supports it");

// ---------------------------------------------------------------------------
// Output naming through the panel, against real-shaped sequence names
// ---------------------------------------------------------------------------

app.state.sequences = [
  { id: "seq-1", name: "VR_ChristmasCampaign_Teaser_8_MASTER_ENG_9x16_V1" }
];
app.state.sourceId = "seq-1";
app.state.settings.gradeSuffix = "_FOR_GRADE";
app.state.settings.mixSuffix = "_FOR_MIX";
app.state.settings.refSuffix = "_REF";
setToggles(true, true, true);

var plan = app.planOutputs();
eq(plan.grade.name, "VR_ChristmasCampaign_Teaser_8_MASTER_ENG_9x16_V1_FOR_GRADE",
   "grade output name appends to the full house name");
eq(plan.mix.name, "VR_ChristmasCampaign_Teaser_8_MASTER_ENG_9x16_V1_FOR_MIX",
   "mix output name appends to the full house name");
eq(plan.ref.name, "VR_ChristmasCampaign_Teaser_8_MASTER_ENG_9x16_V1_REF",
   "reference output name appends to the full house name");

// Grade and Mix in ONE run must not collide with each other's planned name.
app.state.settings.gradeSuffix = "_FOR_ONLINE";
app.state.settings.mixSuffix = "_FOR_ONLINE";
plan = app.planOutputs();
ok(plan.grade.name !== plan.mix.name,
   "grade and mix cannot claim the same name in a single run");
eq(plan.mix.collided, true, "the second claimant versions up");
app.state.settings.gradeSuffix = "_FOR_GRADE";
app.state.settings.mixSuffix = "_FOR_MIX";

// A blank suffix falls back to the default rather than shadowing the source.
app.state.settings.gradeSuffix = "";
eq(app.effectiveSuffix("gradeSuffix"), "_FOR_GRADE", "blank suffix falls back to the default");
plan = app.planOutputs();
ok(plan.grade.name.indexOf("_FOR_GRADE") > 0, "blank suffix still produces a distinct name");
app.state.settings.gradeSuffix = "_FOR_GRADE";

// ---------------------------------------------------------------------------
// Bin reporting
// ---------------------------------------------------------------------------

var found = { exhausted: false, bins: {
  FOR_GRADE: { found: true, path: "/1_3_MAIN_CUTS/ONLINE/FOR_GRADE", duplicates: [] },
  FOR_MIX: { found: false, path: null, duplicates: [] }
} };
ok(app.binLine("FOR_GRADE", found).indexOf("/1_3_MAIN_CUTS/ONLINE/FOR_GRADE") > 0,
   "an existing bin is reported with its path");
ok(app.binLine("FOR_MIX", found).indexOf("will be created") > 0,
   "a missing bin says it will be created");

var dupes = { exhausted: false, bins: {
  FOR_GRADE: { found: true, path: "/A/FOR_GRADE", duplicates: ["/B/FOR_GRADE"] }
} };
ok(app.binLine("FOR_GRADE", dupes).indexOf("1 other bin") > 0,
   "duplicate bin names are surfaced rather than silently picked");

ok(app.binLine("FOR_GRADE", { exhausted: true, bins: {} }).indexOf("too large") > 0,
   "an exhausted search says so instead of claiming the bin is missing");

// ---------------------------------------------------------------------------
// Suffix persistence between runs
// ---------------------------------------------------------------------------

ok(prefs.isPersistent() === true, "the settings store reports itself persistent");

var s = prefs.load();
s.gradeSuffix = "_FOR_ONLINE_GRADE";
s.mixSuffix = "_FOR_DUB";
s.refSuffix = "_VIEWING";
s.gradeEnabled = true;
s.mixEffects = "remove";
prefs.save(s);

// A fresh load is what the next panel launch does.
var reloaded = prefs.load();
eq(reloaded.gradeSuffix, "_FOR_ONLINE_GRADE", "grade suffix persists between runs");
eq(reloaded.mixSuffix, "_FOR_DUB", "mix suffix persists between runs");
eq(reloaded.refSuffix, "_VIEWING", "reference suffix persists between runs");
eq(reloaded.gradeEnabled, true, "section toggle persists between runs");
eq(reloaded.mixEffects, "remove", "effects radio persists between runs");

// An empty suffix must not be honoured on reload - it would name the output
// exactly like its source.
var bad = prefs.load();
bad.gradeSuffix = "";
bad.mixSuffix = "   ";
prefs.save(bad);
var recovered = prefs.load();
eq(recovered.gradeSuffix, "_FOR_GRADE", "empty stored suffix falls back to the default");
eq(recovered.mixSuffix, "_FOR_MIX", "whitespace stored suffix falls back to the default");

// A junk value in the radio must not leave the panel in an unrenderable state.
var junk = prefs.load();
junk.mixEffects = "render";   // a mode that no longer exists
prefs.save(junk);
eq(prefs.load().mixEffects, "keep",
   "a stored effects mode that no longer exists falls back to keep, so an old " +
   "saved setting cannot leave the panel in a state it can no longer render");

// Corrupt store: the panel must still come up on defaults.
STORE["theonliner.prefs.v1"] = "{not json";
eq(prefs.load().gradeSuffix, "_FOR_GRADE", "a corrupt settings store falls back to defaults");

prefs.reset();
eq(prefs.load().gradeSuffix, prefs.DEFAULTS.gradeSuffix, "reset restores the defaults");

// ---------------------------------------------------------------------------
// Controls round-trip
// ---------------------------------------------------------------------------

var wanted = prefs.load();
wanted.refEnabled = true;
wanted.gradeEnabled = false;
wanted.mixEnabled = true;
wanted.gradeSuffix = "_G";
wanted.mixEffects = "remove";
app.writeControls(wanted);
var readBack = app.readControls();
eq(readBack.refEnabled, true, "checkbox writes then reads back");
eq(readBack.gradeEnabled, false, "unticked checkbox reads back false");
eq(readBack.gradeSuffix, "_G", "text field writes then reads back");
eq(readBack.mixEffects, "remove", "radio group writes then reads back");

// ---------------------------------------------------------------------------
// The multicam gate
// ---------------------------------------------------------------------------

var ppro = LOADED["./js/ppro"];
var exportCalls = [];
var scanResult = [];

// Stub the Premiere calls the gate uses. app.js holds a reference to this
// module object, so patching the exports patches what it calls.
ppro.scanMulticam = function () { return Promise.resolve(scanResult); };
ppro.countVideoClips = function () { return Promise.resolve(42); };
ppro.exportFCPXML = function (id, path, expected) {
  exportCalls.push({ id: id, path: path, expected: expected });
  return Promise.resolve({ exported: true, path: path, expected: expected, found: expected, shortfall: 0 });
};

/**
 * Let a chain of awaits settle. jsc has no event loop to await into from top
 * level, and continueGrade awaits several times, so drain generously rather
 * than counting ticks - counting them made this test fail on working code.
 */
function flush(n, then) {
  var pr = Promise.resolve();
  for (var i = 0; i < n; i++) pr = pr.then(function () {});
  pr.then(then);
}

function pending(multicam) {
  return {
    sequenceId: "seq-clone", outName: "MyEdit_FOR_GRADE",
    xmlPath: "/tmp/grade/MyEdit_FOR_GRADE.xml",
    summary: { multicam: multicam },
    bin: { path: "/FOR_GRADE" }
  };
}

// --- still dirty: must NOT export ------------------------------------------
app.state.pendingGrade = pending([{ track: "V1", name: "A" }, { track: "V2", name: "B" }]);
scanResult = [{ track: "V1", name: "A" }];
exportCalls = [];
app.continueGrade();

flush(30, function () {
  ok(exportCalls.length === 0, "Continue does not write the XML while multicam clips remain");
  ok(app.state.pendingGrade !== null, "the run stays paused when multicam clips remain");
  ok(ELS.continueRow.hidden === false, "the Continue affordance stays visible when clips remain");

  // --- flattened: exports, using a FRESH clip count ------------------------
  app.state.pendingGrade = pending([{ track: "V1", name: "A" }]);
  scanResult = [];
  exportCalls = [];
  app.continueGrade();

  flush(30, function () {
    ok(exportCalls.length === 1, "Continue writes the XML once multicam is clear");
    ok(exportCalls.length === 1 && exportCalls[0].expected === 42,
       "the XML is verified against a FRESH clip count, not the pre-flatten one");
    ok(app.state.pendingGrade === null, "the pending run is cleared after a successful continue");
    ok(ELS.continueRow.hidden === true, "the Continue affordance hides once done");

    // --- skip ---------------------------------------------------------------
    app.state.pendingGrade = { outName: "MyEdit_FOR_GRADE" };
    app.skipXml();
    ok(app.state.pendingGrade === null, "Skip clears the pending run");
    ok(ELS.continueRow.hidden === true, "Skip hides the Continue affordance");

    ok(/cannot flatten them for you/i.test(app.multicamNote([{ track: "V1", name: "A" }])),
       "the note is explicit that the panel will not guess the angle");

    // --- the shared report formatting ------------------------------------
    // Clip lists used to be one run-on sentence where the reason - the part an
    // editor acts on - was the dimmest text on the panel.

    var g = app.reportGroup({
      title: "Hidden clips removed", kind: "ok", total: 2,
      lead: "Check for alpha.",
      rows: [{ track: "V1", name: "A004R023", why: "under B005L019" },
             { track: "V2", name: "B005L019" }]
    });
    ok(/class="rsec ok"/.test(g), "the group carries its severity class");
    ok(/rsec-title">Hidden clips removed</.test(g), "the title is the title");
    ok(/rsec-count">2</.test(g), "the count badge shows the total");
    ok(/rsec-lead">Check for alpha\.</.test(g), "the lead sits under the heading");
    ok(/class="trk">V1</.test(g), "the track is its own element");
    ok(/class="nm">A004R023</.test(g), "the clip name is its own element");
    ok(/class="why">under B005L019</.test(g), "the reason is its own element");
    ok(/rrow notc/.test(g), "rows are marked as having no timecode column");
    ok(g.split('class="nm"').length - 1 === 2, "one row per clip");
    ok(!/undefined/.test(g), "a row without a reason does not print 'undefined'");

    // A clip name is attacker-ish only by accident, but it is still user data.
    var esc = app.reportGroup({ title: "T", total: 1,
      rows: [{ name: '<img src=x onerror="alert(1)">', why: "a & b" }] });
    ok(!/<img/.test(esc), "clip names are escaped, not injected as markup");
    ok(/&amp;/.test(esc), "ampersands in reasons are escaped");

    // The cap keeps one group from filling the panel, and says what it hid.
    var many = [];
    for (var i = 0; i < 20; i++) many.push({ track: "V1", name: "clip" + i });
    var capped = app.reportGroup({ title: "Many", total: 20, rows: app.clipRows(many, 6) });
    ok(capped.split('class="nm"').length - 1 === 6, "the row list is capped");
    ok(/and 14 more/.test(capped), "and the remainder is counted, not silently dropped");
    ok(/<div class="rrow notc"><div class="why">and 14 more/.test(capped),
       "the overflow line is a row, so it lines up with the clips above it");

    var exact = app.reportGroup({ title: "Few", rows: app.clipRows(many.slice(0, 3), 6) });
    ok(!/more</.test(exact), "no 'and N more' when everything is shown");
    ok(/rsec-count">3</.test(exact), "the count defaults to the row count");

    ok(app.clipRows(null, 5).length === 0, "a missing list yields no rows");
    ok(app.clipRows(many, 4, function (c) { return c.name + "!"; })[0].why === "clip0!",
       "the reason can be derived per clip");

print("");
    print(passed + " passed, " + failed + " failed");
    if (failed > 0) throw new Error(failed + " test(s) failed");
  });
});

// ---------------------------------------------------------------------------

if (false) print("");
