/**
 * app.js - panel UI and state. Knows nothing about the premierepro API; every
 * call into Premiere goes through js/ppro.js.
 *
 * Phase 1 scope: the three sections and their reveal/disable behaviour, the
 * suffix fields and their persistence, live output-name previews including
 * collision versioning, and the analysis (dry-run) report. Nothing here writes
 * to the project yet.
 */

// UXP resolves require() against the PLUGIN ROOT, not against the folder of
// the file doing the requiring - the loader reports "Parent module folder was:
// ./" even for a script under js/. So these are root-relative, not
// sibling-relative, despite all four files living in the same directory.
const prefs = require("./js/prefs");
const naming = require("./js/naming");
const ppro = require("./js/ppro");
const presets = require("./js/presets");
const fcpxml = require("./js/fcpxml");
const platform = require("./js/platform");

const $ = (id) => document.getElementById(id);

// Every control, so state can be read and written in one sweep.
const CONTROLS = {
  refEnabled: "checkbox", refBurnIn: "checkbox", refSuffix: "text",
  refExportMode: "radio",
  gradeEnabled: "checkbox", gradeStripToVideo: "checkbox",
  gradeResetMotion: "checkbox", gradeRemoveEffects: "checkbox",
  gradeExportXML: "checkbox", gradeSuffix: "text",
  gradeRemoveDisabled: "checkbox",
  gradeRemoveAdjustment: "checkbox", gradeRemoveHidden: "checkbox",
  gradeFlatten: "checkbox", gradeStripEmptyTracks: "checkbox",
  mixEnabled: "checkbox", mixStripToAudio: "checkbox", mixRemoveDisabled: "checkbox",
  mixEffects: "radio", mixExportAAF: "checkbox", mixSuffix: "text",
  aafMixdownVideo: "checkbox", aafExplodeToMono: "checkbox",
  aafRenderAudioEffects: "checkbox", aafInterleaveWithoutEffects: "checkbox",
  aafPreserveParentFolder: "checkbox",
  aafSampleRate: "text", aafBitsPerSample: "text", aafFiles: "text",
  aafFormat: "text", aafRender: "text", aafHandleFrames: "text"
};

const state = {
  settings: prefs.load(),
  sequences: [],
  sourceId: null,
  caps: null,
  busy: false,
  presets: [],
  refFolder: null,        // { path, token } - a UXP folder entry the user picked
  gradeFolder: null,
  mixFolder: null,
  pendingGrade: null,     // a grade run halted at the multicam gate
  lastRun: null
};

// ---------------------------------------------------------------------------
// Reading and writing the controls
// ---------------------------------------------------------------------------

function writeControls(settings) {
  Object.keys(CONTROLS).forEach((id) => {
    const el = $(id);
    if (!el) return;
    const kind = CONTROLS[id];
    if (kind === "checkbox") el.checked = !!settings[id];
    else if (kind === "radio") el.selected = settings[id];
    else el.value = settings[id] == null ? "" : String(settings[id]);
  });
}

function readControls() {
  const out = {};
  Object.keys(CONTROLS).forEach((id) => {
    const el = $(id);
    if (!el) return;
    const kind = CONTROLS[id];
    if (kind === "checkbox") out[id] = !!el.checked;
    else if (kind === "radio") out[id] = el.selected;
    else out[id] = String(el.value == null ? "" : el.value);
  });
  return out;
}

/**
 * A blank suffix would name the output exactly like its source, and the
 * collision rule would then quietly hand back "<source>_v02" - traceable, but
 * not what anyone meant. Fall back to the default instead, and say so.
 */
function effectiveSuffix(key) {
  const typed = String(state.settings[key] || "").trim();
  return typed || prefs.DEFAULTS[key];
}

// ---------------------------------------------------------------------------
// Reveal / disable behaviour
// ---------------------------------------------------------------------------

function applyToggleState() {
  const s = state.settings;

  // Reference: sub-options stay visible but grey out, per the spec.
  $("secRef").classList.toggle("on", s.refEnabled);
  $("refBody").classList.toggle("disabled", !s.refEnabled);

  // Grade and Mix: the body is revealed by the top-level toggle.
  $("secGrade").classList.toggle("on", s.gradeEnabled);
  $("gradeBody").hidden = !s.gradeEnabled;

  $("secMix").classList.toggle("on", s.mixEnabled);
  $("mixBody").hidden = !s.mixEnabled;

  // An FCPXML of nothing is not useful: if every strip/reset option is off the
  // output is just a copy, which is legitimate, so this only informs.
  // Gate the options that would otherwise queue a job the host cannot do.
  // Note this sets `disabled` in BOTH directions: a probe that fails once -
  // AME not up yet, a transient throw - must not leave the control dead for
  // the rest of the session, since Refresh re-probes.
  const caps = state.caps;
  if (caps) {
    const gate = (id, supported) => {
      const el = $(id);
      el.disabled = !supported;
      if (!supported) el.checked = false;
    };
    gate("mixExportAAF", caps.exportAAF);
    gate("gradeExportXML", caps.exportFCPXML);
    gate("refBurnIn", !!caps.timecodeFilter);
  }

  $("refExportModeNote").textContent = {
    now: "Starts on its own and needs no one to press Start — but Premiere is busy until it finishes.",
    ame: "Lands in the Media Encoder queue and waits there. Someone has to press Start: Premiere cannot start AME's queue."
  }[state.settings.refExportMode] || "";

  $("mixEffectsNote").textContent = {
    keep: "Effects travel to the mix as they are. To bake them into the exported media instead, tick \u201CRender audio clip effects\u201D below — that is Premiere's own Render and Replace.",
    remove: "Effects are stripped from the timeline. Volume, Channel Volume and Pan are kept — they carry the edit's levels, not effects."
  }[state.settings.mixEffects] || "";

  // Handle Frames is only meaningful when the audio is being trimmed - Premiere
  // greys it out the same way.
  const trimming = state.settings.aafRender === "trim";
  $("aafHandleFrames").disabled = !trimming;
  $("aafHandleNote").textContent = trimming
    ? "Extra frames either side of each clip, for the mixer to work with."
    : "Only applies when Render is set to Trim Audio Files.";
  $("aafSettings").classList.toggle("disabled", !state.settings.mixExportAAF);

  $("refFolderLine").textContent = state.refFolder ? state.refFolder.path : "No folder chosen";
  $("gradeFolderLine").textContent = state.gradeFolder ? state.gradeFolder.path : "No folder chosen";
  $("mixFolderLine").textContent = state.mixFolder ? state.mixFolder.path : "No folder chosen";

  const anythingOn = s.refEnabled || s.gradeEnabled || s.mixEnabled;
  $("btnAnalyse").disabled = state.busy || !anythingOn || !state.sourceId;
  $("btnProcess").disabled = state.busy || !!processBlockReason();

  // A greyed button that does not say why reads as a broken panel - the user
  // clicks it, nothing happens, and there is nowhere to look. Always state the
  // missing precondition.
  const reason = processBlockReason();
  const hint = $("blockHint");
  hint.textContent = state.busy ? "" : (reason || "");
  hint.hidden = !hint.textContent;
}

/**
 * Why "Add Process to Queue" cannot run, in words the editor can act on.
 * Returns null when the run is good to go.
 */
function processBlockReason() {
  const s = state.settings;
  if (!state.sourceId) return "Open a project and choose a source sequence.";
  if (!(s.refEnabled || s.gradeEnabled || s.mixEnabled)) {
    return "Switch on Reference Export, Grade or Mix first.";
  }
  if (s.refEnabled && !state.refFolder) {
    return "Reference Export needs a destination — use Choose folder… above.";
  }
  if (s.gradeEnabled && s.gradeExportXML && !state.gradeFolder) {
    return "Grade's FCPXML needs a destination — use Choose folder… in the Grade section.";
  }
  // Measured, not theoretical: flattening a full-length adjustment layer down
  // onto V1 overwrote every shot and left 3 clips out of 37. Block the
  // combination before the run rather than failing part-way through it.
  if (s.mixEnabled && s.mixExportAAF && !state.mixFolder) {
    return "Mix's AAF needs a destination — use Choose folder… in the Mix section.";
  }
  if (s.gradeEnabled && s.gradeFlatten && !s.gradeRemoveAdjustment) {
    return "Flattening needs \u201CRemove adjustment layers\u201D on — a full-length " +
           "adjustment layer would flatten down over every clip and empty the timeline.";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Name previews
// ---------------------------------------------------------------------------

function sourceName() {
  const found = state.sequences.find((s) => s.id === state.sourceId);
  return found ? found.name : null;
}

/**
 * What each enabled section would name its output, resolved against the names
 * already in the project. Grade and Mix are resolved against a running list
 * that includes each other's planned names, so enabling both in one run cannot
 * produce two sequences fighting for one name.
 */
function planOutputs() {
  const src = sourceName();
  if (!src) return {};

  const existing = state.sequences.map((s) => s.name);
  const plan = {};
  const claim = (key, suffixKey) => {
    const p = naming.planName(src, effectiveSuffix(suffixKey), existing);
    existing.push(p.name);
    plan[key] = p;
  };

  if (state.settings.refEnabled) claim("ref", "refSuffix");
  if (state.settings.gradeEnabled) claim("grade", "gradeSuffix");
  if (state.settings.mixEnabled) claim("mix", "mixSuffix");
  return plan;
}

function renderPreviews() {
  const plan = planOutputs();
  const paint = (elId, entry, suffixKey) => {
    const el = $(elId);
    if (!el) return;
    if (!entry) {
      el.textContent = "";
      return;
    }
    const typed = String(state.settings[suffixKey] || "").trim();
    const fellBack = !typed;
    el.className = "preview" + (entry.collided ? " collide" : "");
    el.innerHTML =
      '<span class="willbe">Creates </span><span class="name">' +
      escapeHtml(entry.name) + "</span>" +
      (entry.collided ? '<span class="willbe"> &mdash; that name is taken, versioned up</span>' : "") +
      (fellBack ? '<span class="willbe"> &mdash; blank suffix, using ' + escapeHtml(prefs.DEFAULTS[suffixKey]) + "</span>" : "");
  };
  paint("refPreview", plan.ref, "refSuffix");
  paint("gradePreview", plan.grade, "gradeSuffix");
  paint("mixPreview", plan.mix, "mixSuffix");
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ---------------------------------------------------------------------------
// Status and report
// ---------------------------------------------------------------------------

/**
 * Append a line to a log file in the plugin's data folder. The panel cannot be
 * observed from outside Premiere, so without this a failed run leaves no trace
 * once the status line is overwritten.
 */
async function logLine(text) {
  try {
    const uxp = require("uxp");
    const folder = await uxp.storage.localFileSystem.getDataFolder();
    let file;
    try { file = await folder.getEntry("onliner.log"); }
    catch (e) { file = await folder.createFile("onliner.log", { overwrite: false }); }
    const stamp = new Date().toISOString();
    const previous = await file.read().catch(() => "");
    await file.write(String(previous || "") + stamp + "  " + text + "\n");
  } catch (e) {
    // Logging must never break a run.
  }
}

function setStatus(msg, kind) {
  const el = $("status");
  el.textContent = msg || "";
  el.className = "status" + (kind ? " " + kind : "");
}

function showReport(html) {
  $("report").innerHTML = html;
  $("reportSection").hidden = !html;
}

// ---------------------------------------------------------------------------
// Project reads
// ---------------------------------------------------------------------------

async function refreshProject() {
  if (!ppro.isAvailable()) {
    $("projectLine").textContent = "Premiere API unavailable.";
    return;
  }
  try {
    const summary = await ppro.readProjectSummary();
    if (!summary) {
      $("projectLine").textContent = "No project open.";
      state.sequences = [];
      state.sourceId = null;
      renderSourceOptions();
      applyToggleState();
      return;
    }
    $("projectLine").textContent = summary.name;
    $("projectLine").title = summary.path || "";

    state.sequences = await ppro.listSequences();

    // Default to whatever the editor is looking at, which is nearly always the
    // sequence they want prepped. Keep the current pick if it still exists.
    const stillThere = state.sequences.some((s) => s.id === state.sourceId);
    if (!stillThere) {
      state.sourceId = summary.activeSequence
        ? summary.activeSequence.id
        : (state.sequences[0] ? state.sequences[0].id : null);
    }
    renderSourceOptions();
    renderPreviews();
    applyToggleState();
    setStatus("");
  } catch (e) {
    $("projectLine").textContent = "Could not read the project.";
    setStatus(String(e.message || e), "bad");
  }
}

function renderSourceOptions() {
  const sel = $("sourceSelect");
  sel.innerHTML = "";
  if (!state.sequences.length) {
    const opt = document.createElement("option");
    opt.textContent = "No sequences in this project";
    sel.appendChild(opt);
    sel.disabled = true;
    return;
  }
  sel.disabled = false;
  state.sequences.forEach((s) => {
    const opt = document.createElement("option");
    opt.value = s.id;
    opt.textContent = s.name;
    if (s.id === state.sourceId) opt.selected = true;
    sel.appendChild(opt);
  });
}

async function refreshCapabilities() {
  if (!ppro.isAvailable()) {
    $("capsLine").textContent = "Not running inside Premiere.";
    return;
  }
  try {
    state.caps = await ppro.probeCapabilities();
    const c = state.caps;
    const bits = [];
    bits.push("Premiere " + (c.hostVersion || "?"));
    const via = c.exportVia || {};
    bits.push(via.fcpxml === "cep" ? "FCPXML ✓ via CEP" : (c.exportFCPXML ? "FCPXML ✓" : "FCPXML ✗"));
    bits.push(via.aaf === "cep" ? "AAF ✓ via CEP" : (c.exportAAF ? "AAF ✓" : "AAF ✗"));
    bits.push(c.ameInstalled ? "AME ✓" : "AME ✗");
    bits.push(c.timecodeFilter ? "Burn-in ✓" : "Burn-in ✗");
    if (!prefs.isPersistent()) bits.push("settings not persisting");
    $("capsLine").textContent = bits.join("  ·  ");
    // This build cannot export natively and the bridge that would is not up:
    // say so where the editor will look, rather than leaving two dead ticks.
    const bridge = c.cepBridge;
    $("capsNote").textContent = (!c.exportFCPXML || !c.exportAAF) && bridge && !bridge.running
      ? "This Premiere cannot export FCPXML or AAF from a plugin panel. The Onliner CEP Bridge does " +
        "it instead — install it with scripts/install-dev and restart Premiere. Then press \u21BB."
      : "";
    applyToggleState();
  } catch (e) {
    $("capsLine").textContent = "Capability probe failed: " + (e.message || e);
  }
}

// ---------------------------------------------------------------------------
// Analysis (dry run)
// ---------------------------------------------------------------------------

async function runAnalysis() {
  const src = sourceName();
  if (!src) return;
  state.busy = true;
  applyToggleState();
  setStatus("Analysing…");
  try {
    const shape = await ppro.readSequenceShape(state.sourceId);
    const plan = planOutputs();
    const bins = await ppro.findBins([naming.BINS.grade, naming.BINS.mix]);
    showReport(renderAnalysis(shape, plan, bins));
    setStatus("Analysis only — nothing was written.", "good");
  } catch (e) {
    setStatus(String(e.message || e), "bad");
  } finally {
    state.busy = false;
    applyToggleState();
  }
}

/**
 * How the destination bin is described in the report. Saying "found at
 * .../ONLINE/FOR_GRADE" versus "will be created" is the difference between the
 * editor trusting the run and going to look for themselves.
 */
function binLine(binName, bins) {
  if (!binName) return "";
  const info = bins && bins.bins ? bins.bins[binName] : null;
  if (info && info.found) {
    let text = binName + " — found at " + info.path;
    if (info.duplicates.length) {
      text += " (" + info.duplicates.length + " other bin(s) share this name)";
    }
    return kv("Bin", text);
  }
  if (bins && bins.exhausted) {
    return kv("Bin", binName + " — project too large to search, will be checked at run time");
  }
  return kv("Bin", binName + " — none found, will be created at the project root");
}

function renderAnalysis(shape, plan, bins) {
  const s = state.settings;
  let html = "";

  html += '<div class="card"><h3>Source</h3>' +
    kv("Sequence", shape.name) +
    kv("Video tracks", shape.videoTrackCount + " (" + shape.videoClips + " clips)") +
    kv("Audio tracks", shape.audioTrackCount + " (" + shape.audioClips + " clips)") +
    (shape.captionTrackCount ? kv("Caption tracks", shape.captionTrackCount) : "") +
    "</div>";

  if (s.refEnabled && plan.ref) {
    html += '<div class="card"><h3>Reference Export</h3>' +
      kv("New sequence", plan.ref.name) +
      kv("Timecode burn-in", s.refBurnIn ? "Yes, on an adjustment layer" : "No") +
      '<div class="note">Export is queued in Phase 2.</div></div>';
  }

  if (s.gradeEnabled && plan.grade) {
    const ops = [];
    if (s.gradeStripToVideo) ops.push("strip " + shape.audioTrackCount + " audio track(s)");
    if (s.gradeResetMotion) ops.push("reset Motion on " + shape.videoClips + " clip(s)");
    if (s.gradeRemoveEffects) ops.push("remove other effects");
    html += '<div class="card grade"><h3>Grade</h3>' +
      kv("New sequence", plan.grade.name) +
      binLine(naming.BINS.grade, bins) +
      kv("Colour label", "Violet") +
      kv("Would do", ops.length ? ops.join(", ") : "nothing — a plain copy") +
      kv("FCPXML", s.gradeExportXML ? "Yes" : "No") +
      '<div class="note">Time Remapping is listed here in Phase 3.</div></div>';
  }

  if (s.mixEnabled && plan.mix) {
    html += '<div class="card mix"><h3>Mix</h3>' +
      kv("New sequence", plan.mix.name) +
      binLine(naming.BINS.mix, bins) +
      kv("Colour label", "Cerulean") +
      kv("Would do", s.mixStripToAudio
        ? "strip " + shape.videoTrackCount + " video track(s)"
        : "keep all tracks") +
      kv("Effects", { keep: "Keep", render: "Render and Replace", remove: "Remove" }[s.mixEffects]) +
      kv("AAF", s.mixExportAAF ? "Yes" : "No") +
      '<div class="note">Processing lands in Phase 4.</div></div>';
  }

  return html;
}

function kv(k, v) {
  return '<div class="kv"><span>' + escapeHtml(k) + "</span><span>" + escapeHtml(v) + "</span></div>";
}

// ---------------------------------------------------------------------------
// Presets and destination folder
// ---------------------------------------------------------------------------

async function loadPresets() {
  try {
    state.presets = await presets.findPresets();
  } catch (e) {
    state.presets = [];
    $("refPresetNote").textContent = "Could not read the preset folders: " + (e.message || e);
  }
  const sel = $("refPreset");
  sel.innerHTML = "";

  const none = document.createElement("option");
  none.value = "";
  none.textContent = state.presets.length
    ? "Sequence's own export settings"
    : "Sequence's own export settings (no presets found)";
  sel.appendChild(none);

  state.presets.forEach((preset) => {
    const opt = document.createElement("option");
    opt.value = preset.path;
    opt.textContent = (preset.source === "user" ? "★ " : "") + preset.name;
    if (preset.path === state.settings.refPresetPath) opt.selected = true;
    sel.appendChild(opt);
  });

  if (state.presets.length) {
    const mine = state.presets.filter((x) => x.source === "user").length;
    $("refPresetNote").textContent =
      state.presets.length + " presets found, " + mine + " of them yours (★).";
  }
  // Where the panel looked and what it found. This is the first thing to read
  // on a machine where the preset list comes up short.
  try {
    const src = presets.presetSources();
    logLine("PRESETS platform=" + src.platform + " home=" + (src.home || "none") +
            " opened-by=" + (platform.openEntry.lastShape || "nothing") +
            " found=" + state.presets.length +
            " user=" + state.presets.filter((x) => x.source === "user").length +
            " looked=" + src.userDirs.concat(src.appDirs).join(" | "));
  } catch (e) { /* diagnostics only */ }
  // No home folder means the house presets were never looked for. Say so,
  // or an editor sees Adobe's list with theirs missing and blames the panel.
  let sources = null;
  try { sources = presets.presetSources(); } catch (e) { sources = null; }
  if (sources && !sources.home) {
    $("refPresetNote").textContent +=
      " This host gave no home folder, so your own presets under Documents could not be searched for.";
  }
}

async function pickFolder(which) {
  try {
    const uxp = require("uxp");
    const folder = await uxp.storage.localFileSystem.getFolder();
    if (!folder) return;
    state[which] = { path: folder.nativePath, entry: folder };
    applyToggleState();
  } catch (e) {
    setStatus("Could not open the folder picker: " + (e.message || e), "bad");
  }
}

async function pickRefFolder() {
  try {
    const uxp = require("uxp");
    const folder = await uxp.storage.localFileSystem.getFolder();
    if (!folder) return;   // cancelled
    state.refFolder = { path: folder.nativePath, entry: folder };
    applyToggleState();
  } catch (e) {
    setStatus("Could not open the folder picker: " + (e.message || e), "bad");
  }
}

// ---------------------------------------------------------------------------
// Phase 2 - reference export
// ---------------------------------------------------------------------------

/**
 * Burn-in ON  -> build a reference sequence as a nest of the source, put the
 *                burn-in on it, export that.
 * Burn-in OFF -> export the source sequence straight out. No new sequence is
 *                made, because nothing needs to carry an effect - which is also
 *                what makes the no-timecode path provably non-destructive.
 */
async function runReferenceExport(plan, results) {
  const s = state.settings;
  const src = sourceName();
  const outName = plan.ref.name;
  const stem = naming.toFileStem(outName);
  const presetPath = $("refPreset").value || "";

  let exportSequenceId = state.sourceId;
  let createdSequence = null;

  if (s.refBurnIn) {
    const created = await ppro.createReferenceSequence(state.sourceId, outName);
    createdSequence = created;
    exportSequenceId = created.id;
    try {
      const matchName = state.caps.timecodeFilter.matchName;
      const burn = await ppro.applyTimecodeBurnIn(created.id, matchName, {});
      logLine("REF burn-in frameWidth=" + burn.frameWidth + " size=" + burn.size +
              " x=" + burn.x + (burn.shrunk ? " (shrunk to fit)" : "") +
              (burn.positioned ? "" : " (Adobe's default position - frame width unknown)"));
    } catch (e) {
      // A reference sequence with no timecode on it looks fine and is wrong.
      // Roll it back rather than leave a decoy in the project.
      try { await ppro.deleteSequenceById(created.id); } catch (e2) { /* keep the original error */ }
      throw new Error("Burn-in failed, reference sequence removed: " + (e.message || e));
    }
  }

  const mode = s.refExportMode === "ame" ? "ame" : "now";
  const queued = await ppro.queueExport(
    exportSequenceId,
    platform.joinPath(state.refFolder.path, stem),
    presetPath,
    mode
  );
  logLine("REF export mode=" + mode + " started=" + (queued && queued.started));

  results.push({
    title: "Reference Export",
    rows: [
      ["Source", src],
      ["Exported sequence", createdSequence ? createdSequence.name : src + " (direct, no copy made)"],
      ["Timecode burn-in", s.refBurnIn ? "Yes, on a nest of the source" : "No"],
      ["Preset", presetPath ? platform.baseName(presetPath) : "Sequence's own export settings"],
      ["Destination", state.refFolder.path],
      ["Render", mode === "now"
        ? (queued && queued.started ? "Rendered in Premiere — no queue, no Start needed" : "Premiere refused the render")
        : (queued && queued.started ? "Queued to Media Encoder — press Start there" : "Media Encoder refused the job")]
    ],
    warn: (queued && queued.started) ? null
      : (mode === "now" ? "Premiere did not accept the render." : "Media Encoder did not accept the job.")
  });
}

/**
 * Phase 3: duplicate the locked sequence, strip it back to picture, reset every
 * reframe, drop the temp grade, and hand the colourist an FCPXML.
 */
async function runGradeTimeline(plan, results) {
  const s = state.settings;
  const src = sourceName();
  const outName = plan.grade.name;

  // cloneSequence hands back { id, name } - a GUID, not a Sequence. Holding a
  // Sequence across the pipeline is what made a run flatten 12 clips and then
  // die on the next call: the object goes stale.
  const clone = await ppro.cloneSequence(state.sourceId);
  await ppro.renameSequence(clone.id, outName);
  logLine("GRADE clone made as " + outName);

  // From here on the clone is being altered. If anything throws part-way, what
  // is left is a half-prepped sequence that LOOKS like a finished grade
  // timeline - audio stripped, some clips reset, some not. That is a decoy on
  // the way to a colourist, so it is removed rather than left to be found.
  try {
    return await buildGradeSequence(clone.id, plan, results);
  } catch (e) {
    try {
      await ppro.deleteSequenceById(clone.id);
      logLine("GRADE rolled back half-built sequence " + outName);
      throw new Error((e.message || e) + " — the half-built \u201C" + outName +
                      "\u201D was removed, your source is untouched.");
    } catch (rollbackFailed) {
      if (rollbackFailed !== e && !/half-built/.test(String(rollbackFailed.message || ""))) {
        logLine("GRADE rollback FAILED for " + outName + ": " + (rollbackFailed.message || rollbackFailed));
        throw new Error((e.message || e) + " — and the half-built \u201C" + outName +
                        "\u201D could NOT be removed; delete it by hand before using it.");
      }
      throw rollbackFailed;
    }
  }
}

async function buildGradeSequence(cloneId, plan, results) {
  const s = state.settings;
  const src = sourceName();
  const outName = plan.grade.name;

  let audioRemoved = 0;
  if (s.gradeStripToVideo) audioRemoved = await ppro.stripAudioClips(cloneId);

  // All three removals run BEFORE the clip walk, so dead clips are not reset,
  // not counted, and cannot trip the multicam gate on their way out.
  let disabledRemoved = [];
  if (s.gradeRemoveDisabled) {
    disabledRemoved = await ppro.removeDisabledClips(cloneId, "video");
    logLine("GRADE removed " + disabledRemoved.length + " disabled clip(s)");
  }

  let adjustmentRemoved = [];
  if (s.gradeRemoveAdjustment) {
    adjustmentRemoved = await ppro.removeAdjustmentLayers(cloneId);
    logLine("GRADE removed " + adjustmentRemoved.length + " adjustment layer(s)");
  }

  // After the adjustment layers, so a full-length LUT layer is already gone and
  // cannot be mistaken for something that hides the picture.
  let hidden = { removed: [], partial: [] };
  if (s.gradeRemoveHidden) {
    hidden = await ppro.removeHiddenClips(cloneId);
    logLine("GRADE removed " + hidden.removed.length + " hidden clip(s), " +
            hidden.partial.length + " partly covered kept");
  }

  // After the removals, so nothing invisible or pass-through gets flattened
  // down into the picture, and before the clip walk so the moved clips are
  // reset and counted in their final position.
  let flat = null;
  if (s.gradeFlatten) {
    flat = await ppro.flattenToSingleTrack(cloneId);
    logLine("GRADE flattened " + flat.moved.length + " clip(s) to V1, " +
            flat.failed.length + " failed, " + flat.leftAbove + " left above V1");
  }

  const summary = await ppro.processGradeClips(cloneId, {
    resetMotion: s.gradeResetMotion,
    removeEffects: s.gradeRemoveEffects
  });

  const bin = await ppro.fileSequence(cloneId, naming.BINS.grade, ppro.COLOUR.GRADE);

  const manifest = [
    "The Onliner — grade prep",
    "Source: " + src,
    "When: " + new Date().toISOString(),
    "Stripped to video: " + (s.gradeStripToVideo ? "yes (" + audioRemoved + " audio clips removed)" : "no"),
    "Disabled clips removed: " + (s.gradeRemoveDisabled ? disabledRemoved.length : "kept"),
    "Adjustment layers removed: " + (s.gradeRemoveAdjustment ? adjustmentRemoved.length : "kept"),
    "Hidden clips removed: " + (s.gradeRemoveHidden ? hidden.removed.length : "kept"),
    "Flattened to V1: " + (flat ? flat.moved.length + " moved" : "no"),
    "Motion reset: " + (s.gradeResetMotion ? "yes (" + summary.motionReset + " clips)" : "no"),
    "Effects removed: " + (s.gradeRemoveEffects ? summary.effectsRemoved : "no"),
    "Stabilisation kept on " + summary.stabilised.length + " clip(s)",
    "Speed changes found: " + summary.retimed.length
  ].join("\n");
  await ppro.writeRunManifest(cloneId, manifest);

  const xmlPath = (s.gradeExportXML && state.gradeFolder)
    ? platform.joinPath(state.gradeFolder.path, naming.toFileStem(outName) + ".xml")
    : null;

  // The multicam gate. Stop BEFORE writing an XML that would be short of
  // shots, and hand the timeline back to the editor to flatten - by then the
  // grade sequence exists and is fully prepped, so they flatten there and
  // their locked offline is never touched.
  if (xmlPath && summary.multicam.length) {
    state.pendingGrade = {
      sequenceId: cloneId, outName, xmlPath, summary, bin,
      audioRemoved, manifest,
      folder: state.gradeFolder   // { path, entry } - the entry is what verifies the file
    };
    results.push({
      title: "Grade — waiting for you",
      rows: [
        ["New sequence", outName],
        ["Bin", bin.path + (bin.created ? " (created)" : " (existing)")],
        ["Multicam clips", String(summary.multicam.length)],
        ["FCPXML", "held back until they are flattened"]
      ],
      warn: null,
      notes: [],
      groups: [reportGroup({
        title: "Multicam — flatten these", kind: "bad", total: summary.multicam.length,
        lead: "The FCPXML is held back until these are gone. Flatten them on the new grade " +
              "sequence, then press Continue. The panel cannot flatten them: Premiere does " +
              "not expose which angle each cut uses, so it would have to guess the camera.",
        rows: clipRows(summary.multicam, 10)
      })]
    });
    showContinue(summary.multicam.length, outName);
    logLine("GRADE paused at multicam gate: " + summary.multicam.length + " clips");
    return "paused";
  }

  let xmlResult = null;
  let stripped = null;
  let translation = null;
  if (xmlPath) {
    xmlResult = await ppro.exportFCPXML(cloneId, xmlPath, summary.clips, state.gradeFolder.entry);
    logLine("GRADE xml via=" + xmlResult.via + " " + xmlPath + " clipitems=" + xmlResult.found + "/" + summary.clips);
    stripped = await stripTracksIfAsked(xmlPath, state.gradeFolder.entry);
    translation = await readTranslationIssues(state.gradeFolder.entry || state.gradeFolder.path, outName);
  }

  const rows = [
    ["Source", src],
    ["New sequence", outName],
    ["Bin", bin.path + (bin.created ? " (created)" : " (existing)")],
    ["Colour label", "Violet"],
    ["Clips processed", String(summary.clips)],
    ["Audio clips removed", s.gradeStripToVideo ? String(audioRemoved) : "not stripped"],
    ["Disabled clips removed", s.gradeRemoveDisabled ? String(disabledRemoved.length) : "kept"],
    ["Adjustment layers removed", s.gradeRemoveAdjustment ? String(adjustmentRemoved.length) : "kept"],
    ["Hidden clips removed", s.gradeRemoveHidden ? String(hidden.removed.length) : "kept"],
    ["Flattened to V1", flat ? flat.moved.length + " clip(s) moved, " + flat.onV1 + " now on V1" : "not flattened"],
    ["Motion reset on", s.gradeResetMotion ? summary.motionReset + " clips" : "not reset"],
    ["Effects removed", s.gradeRemoveEffects ? String(summary.effectsRemoved) : "kept"],
    ["FCPXML", xmlPath ? xmlPath + (xmlResult && xmlResult.via === "cep" ? " (via the CEP bridge)" : "") : "not exported"],
    ["Clips in FCPXML", xmlResult && xmlResult.found != null
      ? xmlResult.found + " of " + summary.clips
      : "not checked"],
    ["Empty tracks stripped", stripped
      ? stripped.removed + " removed, " + stripped.keptWithClips + " kept"
      : (s.gradeStripEmptyTracks ? "no XML to strip" : "left in")],
    ["Premiere couldn't translate", translation && translation.found
      ? (translation.messages.length ? translation.messages.length + " thing(s) — see below" : "nothing")
      : "report not found"],
    ["Multicam clips", summary.multicam.length
      ? summary.multicam.length + " — will not export, see below"
      : "none"]
  ];

  // Two things the colourist must be told about rather than left to discover.
  const notes = [];
  const groups = [];
  if (summary.multicam.length) {
    groups.push(reportGroup({
      title: "Multicam — will not export", kind: "bad", total: summary.multicam.length,
      lead: "These will not survive the FCPXML. Flatten them on the new grade sequence, then " +
            "press Continue. The panel cannot flatten them: Premiere does not expose which " +
            "angle each cut uses, so it would have to guess the camera — and a wrong angle " +
            "looks right.",
      rows: clipRows(summary.multicam, 8)
    }));
  }
  // Flatten is destructive and graphics are removed by hand, so list what came
  // down: a graphic that won over a shot is obvious in this list and nowhere else.
  if (flat && flat.moved.length) {
    groups.push(reportGroup({
      title: "Flattened to V1", kind: "info", total: flat.moved.length,
      lead: "Scan for anything that should not have won — a graphic left in the edit flattens over the shot beneath it.",
      rows: clipRows(flat.moved, 8)
    }));
  }
  if (flat && flat.failed.length) {
    groups.push(reportGroup({
      title: "Could not be flattened", kind: "bad", total: flat.failed.length,
      lead: "Still above V1. Check them by hand before the conform.",
      rows: clipRows(flat.failed, 5, (f) => f.error)
    }));
  }
  if (flat && flat.leftAbove > 0 && !flat.failed.length) {
    notes.push("FLATTEN — " + flat.leftAbove + " clip(s) remain above V1 without reporting an " +
      "error. Worth a look before the conform.");
  }
  if (adjustmentRemoved.length) {
    groups.push(reportGroup({
      title: "Adjustment layers removed", kind: "ok", total: adjustmentRemoved.length,
      lead: "These carry the temp grade.",
      rows: clipRows(adjustmentRemoved, 8)
    }));
  }
  if (hidden.removed.length) {
    groups.push(reportGroup({
      title: "Hidden clips removed", kind: "ok", total: hidden.removed.length,
      lead: "Check this list if any covering clip carries alpha — those do not really hide what is beneath, and the option can be turned off.",
      rows: clipRows(hidden.removed, 6,
        (h) => h.coveredBy.length ? "under " + h.coveredBy.join(", ") : "")
    }));
  }
  if (hidden.partial.length) {
    groups.push(reportGroup({
      title: "Partly covered — kept", kind: "warn", total: hidden.partial.length,
      lead: "Trimming them to the visible part would change the edit, so they are left alone.",
      rows: clipRows(hidden.partial, 6)
    }));
  }
  if (disabledRemoved.length) {
    groups.push(reportGroup({
      title: "Disabled clips removed", kind: "ok", total: disabledRemoved.length,
      lead: "Gaps were left in place rather than rippled, so the timing is unchanged.",
      rows: clipRows(disabledRemoved, 6)
    }));
  }
  // The loudest possible warning: the handoff file is short of shots.
  if (xmlResult && xmlResult.shortfall > 0) {
    notes.push("WARNING — the FCPXML contains " + xmlResult.found + " clips but the timeline has " +
      summary.clips + ". " + xmlResult.shortfall + " are missing. FCP7 XML silently drops multicam " +
      "clips; flatten them to their camera originals before handing this to the colourist, or the " +
      "conform will be short of shots.");
  }
  if (summary.retimed.length) {
    groups.push(reportGroup({
      title: "Speed changes — reset by hand", kind: "warn", total: summary.retimed.length,
      lead: "Time Remapping cannot be reset by any script.",
      rows: clipRows(summary.retimed, 8, (r) => Math.round(r.speed * 100) + "%")
    }));
  }
  if (summary.stabilised.length) {
    groups.push(reportGroup({
      title: "Stabilisation kept", kind: "warn", total: summary.stabilised.length,
      lead: "Warp Stabilizer does NOT survive FCP7 XML export — Premiere's own translation " +
            "report says \u201Cnot translated\u201D. The colourist receives these shots " +
            "UNSTABILISED even though the grade sequence still carries the effect. Handle them " +
            "by hand, or supply a stabilised render.",
      rows: clipRows(summary.stabilised, 8)
    }));
  }
  if (s.gradeStripToVideo) {
    notes.push("Audio tracks are emptied but still present — Premiere has no API to delete a track. " +
      "The FCPXML is what the colourist conforms from.");
  }

  results.push({
    title: "Grade",
    rows,
    groups,
    warn: summary.multicam.length
      ? summary.multicam.length + " multicam clip(s) will not survive the FCPXML — flatten them first."
      : (xmlResult && xmlResult.shortfall > 0
          ? "The FCPXML is missing " + xmlResult.shortfall + " clips — see the Grade card."
          : null),
    notes
  });
}

/**
 * Read what Premiere could not carry into the XML.
 *
 * Premiere writes a "FCP Translation Results" report beside every FCPXML and
 * nothing ever surfaces it, so it goes unread - which is how Warp Stabilizer
 * being silently dropped went unnoticed. Never fatal: the XML is already
 * written, and an unreadable report costs information, not the deliverable.
 */
async function readTranslationIssues(folder, sequenceName) {
  try {
    const report = await fcpxml.readTranslationReport(folder, sequenceName);
    if (report.found && report.messages.length) {
      logLine("GRADE translation issues (" + report.messages.length + "): " + report.messages.join(" | "));
    }
    return report;
  } catch (e) {
    logLine("GRADE could not read the translation report: " + (e.message || e));
    return null;
  }
}

/**
 * Strip the empty tracks out of an exported XML, if the option is on.
 *
 * Never fatal: the XML is already written and correct at this point, so a
 * failure here costs tidiness, not the deliverable.
 */
async function stripTracksIfAsked(xmlPath, folderEntry) {
  if (!state.settings.gradeStripEmptyTracks || !xmlPath) return null;
  try {
    const result = await fcpxml.stripEmptyTracksInFile(xmlPath, folderEntry);
    logLine("GRADE stripped " + result.removed + " empty track(s) from the XML");
    return result;
  } catch (e) {
    logLine("GRADE strip empty tracks FAILED (XML left as exported): " + (e.message || e));
    setStatus("The XML was written, but empty tracks could not be stripped: " + (e.message || e), "warn");
    return null;
  }
}

/**
 * A titled block of clips in a report — the house style shared with The
 * Conformer and The Consolidator.
 *
 * These used to be one long sentence per group: "Removed 5 clip(s) hidden by
 * layers above: V1 A004R023 (under B005L019); V1 A004R027 (under C004R026); …
 * and 3 more." Everything read as equally important, the clip names ran into
 * each other, and the REASON — the part an editor acts on — was the dimmest
 * text on the panel.
 *
 * o = { title, kind, lead, rows: [{ track, name, why }], shown, total }
 * `kind` is one of ok | warn | bad | info | choose, and colours the block.
 */
function reportGroup(o) {
  const rows = o.rows || [];
  const total = (o.total === undefined) ? rows.length : o.total;
  let h = '<div class="rsec' + (o.kind ? " " + o.kind : "") + '">';
  h += '<div class="rsec-head"><span class="rsec-title">' + escapeHtml(o.title) + "</span>";
  if (total !== null) h += '<span class="rsec-count">' + escapeHtml(String(total)) + "</span>";
  h += "</div>";
  if (o.lead) h += '<div class="rsec-lead">' + escapeHtml(o.lead) + "</div>";

  rows.forEach((r) => {
    // "notc": these panels' reports are not timeline-based, so there is no
    // timecode column and the reason lines up under the name.
    h += '<div class="rrow notc' + (r.kind ? " " + r.kind : "") + '"><div class="rrow-top">';
    if (r.track) h += '<span class="trk">' + escapeHtml(r.track) + "</span>";
    h += '<span class="nm">' + escapeHtml(r.name || "") + "</span></div>";
    if (r.why) h += '<div class="why">' + escapeHtml(r.why) + "</div>";
    h += "</div>";
  });

  if (total > rows.length) {
    // Wrapped as a row so it lines up with the clips above it - a bare .why
    // keeps the 52px timecode gutter these panels do not have.
    h += '<div class="rrow notc"><div class="why">and ' +
         (total - rows.length) + " more</div></div>";
  }
  return h + "</div>";
}

/** Build group rows from a clip list, capped so one group cannot fill the panel. */
function clipRows(list, limit, why) {
  const cap = limit || 8;
  return (list || []).slice(0, cap).map((c) => ({
    track: c.track,
    name: c.name,
    why: typeof why === "function" ? why(c) : why
  }));
}

/** One wording for the multicam problem, used by the gate and the report. */
function multicamNote(list) {
  return "MULTICAM — " + list.length + " clip(s) will not survive the FCPXML: " +
    list.slice(0, 8).map((m) => m.track + " " + m.name).join("; ") +
    (list.length > 8 ? "; and " + (list.length - 8) + " more" : "") +
    ". Flatten them on the new grade sequence in Premiere, then press Continue. " +
    "The panel cannot flatten them for you: Premiere does not expose which angle each cut " +
    "uses, so it would have to guess the camera — and a wrong angle looks right.";
}

function showContinue(count, sequenceName) {
  $("continueMsg").textContent =
    count + " multicam clip(s) in \u201C" + sequenceName + "\u201D. Flatten them in that " +
    "sequence, then press Continue and the FCPXML will be checked and written. " +
    "Your locked offline is untouched.";
  $("continueRow").hidden = false;
}

function hideContinue() {
  $("continueRow").hidden = true;
  $("continueMsg").textContent = "";
}

/**
 * Resume a grade run that stopped at the multicam gate. Re-scans rather than
 * trusting that the flattening was done, or finished.
 */
async function continueGrade() {
  const pending = state.pendingGrade;
  if (!pending) return;
  state.busy = true;
  applyToggleState();
  setStatus("Re-checking for multicam…");

  try {
    const remaining = await ppro.scanMulticam(pending.sequenceId);
    if (remaining.length) {
      setStatus(remaining.length + " multicam clip(s) still there — the FCPXML would be short.", "warn");
      showContinue(remaining.length, pending.outName);
      showReport(renderRunReport([{
        title: "Grade — still waiting",
        rows: [["Multicam clips left", String(remaining.length)]],
        warn: null,
        notes: [multicamNote(remaining)]
      }]));
      logLine("GRADE continue: " + remaining.length + " multicam still present");
      return;
    }

    // Clear. The clip count may have changed as a result of flattening, so
    // re-count rather than reusing the number from before.
    const clipCount = await ppro.countVideoClips(pending.sequenceId);
    const folderEntry = pending.folder ? pending.folder.entry : null;
    const xmlResult = await ppro.exportFCPXML(pending.sequenceId, pending.xmlPath, clipCount, folderEntry);
    logLine("GRADE continue: xml via=" + xmlResult.via + " written clipitems=" + xmlResult.found + "/" + clipCount);
    const strippedAfter = await stripTracksIfAsked(pending.xmlPath, folderEntry);
    const translationAfter = await readTranslationIssues(
      folderEntry || platform.dirName(pending.xmlPath), pending.outName);

    hideContinue();
    state.pendingGrade = null;
    showReport(renderRunReport([{
      title: "Grade",
      rows: [
        ["New sequence", pending.outName],
        ["Bin", pending.bin.path],
        ["Clips now", String(clipCount)],
        ["FCPXML", pending.xmlPath],
        ["Clips in FCPXML", xmlResult.found + " of " + clipCount],
        ["Empty tracks stripped", strippedAfter
          ? strippedAfter.removed + " removed, " + strippedAfter.keptWithClips + " kept"
          : "left in"],
        ["Premiere couldn't translate", translationAfter && translationAfter.found
          ? (translationAfter.messages.length ? translationAfter.messages.length + " thing(s)" : "nothing")
          : "report not found"]
      ],
      warn: xmlResult.shortfall > 0
        ? "The FCPXML is still missing " + xmlResult.shortfall + " clips."
        : null,
      notes: ["Multicam cleared — every clip made it into the XML."].concat(
        translationAfter && translationAfter.tidied && translationAfter.tidied.length
          ? ["NOT CARRIED INTO THE XML — " + translationAfter.tidied.slice(0, 6).join("  •  ")]
          : [])
    }]));
    setStatus(xmlResult.shortfall > 0 ? "FCPXML written but short of clips." : "Done — FCPXML written.",
              xmlResult.shortfall > 0 ? "warn" : "good");
  } catch (e) {
    setStatus(String(e.message || e), "bad");
    logLine("GRADE continue failed: " + (e.stack || e.message || e));
  } finally {
    state.busy = false;
    applyToggleState();
  }
}

/** Abandon the XML but keep the prepared grade sequence. */
async function skipXml() {
  const pending = state.pendingGrade;
  hideContinue();
  state.pendingGrade = null;
  if (pending) logLine("GRADE xml skipped by user for " + pending.outName);
  setStatus("FCPXML skipped. The grade sequence \u201C" + (pending ? pending.outName : "") +
            "\u201D is prepared and waiting.", "warn");
}

/**
 * Phase 4: duplicate the locked sequence, strip it back to sound, handle the
 * effects the way the mixer wants them, and hand over an AAF.
 */
async function runMixTimeline(plan, results) {
  const s = state.settings;
  const src = sourceName();
  const outName = plan.mix.name;

  const clone = await ppro.cloneSequence(state.sourceId);
  await ppro.renameSequence(clone.id, outName);
  logLine("MIX clone made as " + outName);

  try {
    let videoRemoved = 0;
    if (s.mixStripToAudio) videoRemoved = await ppro.stripVideoClips(clone.id);

    // Audio tracks, not video: the deliverable here is sound, and a muted clip
    // still travels in the AAF. Before the clip walk so dead audio is not
    // counted or processed on its way out.
    let disabledRemoved = [];
    if (s.mixRemoveDisabled) {
      disabledRemoved = await ppro.removeDisabledClips(clone.id, "audio");
      logLine("MIX removed " + disabledRemoved.length + " disabled audio clip(s)");
    }

    // "Render and Replace" is not a separate export-and-reimport pass: the AAF
    // exporter can bake audio effects into the media it writes, which reaches
    // the same place with far less that can go wrong.
    const mix = await ppro.processMixClips(clone.id, { removeEffects: s.mixEffects === "remove" });

    const bin = await ppro.fileSequence(clone.id, naming.BINS.mix, ppro.COLOUR.MIX);

    await ppro.writeRunManifest(clone.id, [
      "The Onliner — mix prep",
      "Source: " + src,
      "When: " + new Date().toISOString(),
      "Stripped to audio: " + (s.mixStripToAudio ? "yes (" + videoRemoved + " video clips removed)" : "no"),
      "Disabled clips removed: " + (s.mixRemoveDisabled ? disabledRemoved.length : "kept"),
      "Effects: " + s.mixEffects,
      "Audio clips: " + mix.clips
    ].join("\n"));

    let aaf = null;
    if (s.mixExportAAF && state.mixFolder) {
      const aafPath = platform.joinPath(state.mixFolder.path, naming.toFileStem(outName) + ".aaf");
      aaf = await ppro.exportAAF(clone.id, aafPath, {
        mixdownVideo: s.aafMixdownVideo,
        explodeToMono: s.aafExplodeToMono,
        renderAudioEffects: s.aafRenderAudioEffects,
        interleaveWithoutEffects: s.aafInterleaveWithoutEffects,
        sampleRate: parseInt(s.aafSampleRate, 10) || 48000,
        bitsPerSample: parseInt(s.aafBitsPerSample, 10) || 24,
        embedAudio: s.aafFiles === "embedded",
        preserveParentFolder: s.aafPreserveParentFolder,
        audioFileFormat: parseInt(s.aafFormat, 10),
        trimSources: s.aafRender === "trim",
        handleFrames: parseInt(s.aafHandleFrames, 10) || 0
      });
      logLine("MIX aaf via=" + aaf.via + " " + aafPath + " " + JSON.stringify(aaf.settings) +
              (aaf.ignoredOptions && aaf.ignoredOptions.length ? " ignored=" + aaf.ignoredOptions.join(",") : ""));
    }

    // On 25.x the AAF only renders media with Breakout to Mono on, so "render
    // effects" can be asked for and silently not happen - say what DID happen.
    const fxIgnored = !!(aaf && aaf.ignoredOptions && aaf.ignoredOptions.indexOf("Render audio clip effects") >= 0);
    const rows = [
      ["Source", src],
      ["New sequence", outName],
      ["Bin", bin.path + (bin.created ? " (created)" : " (existing)")],
      ["Colour label", "Cerulean"],
      ["Audio clips", String(mix.clips)],
      ["Video clips removed", s.mixStripToAudio ? String(videoRemoved) : "kept"],
      ["Disabled clips removed", s.mixRemoveDisabled ? String(disabledRemoved.length) : "kept"],
      ["Effects on the timeline", { keep: "Kept", remove: "Stripped" }[s.mixEffects]],
      ["Render audio clip effects", !s.aafRenderAudioEffects ? "No"
        : (fxIgnored ? "Asked for, NOT applied — see below" : "Yes — baked into the AAF media")],
      ["Levels kept", s.mixEffects === "remove" ? String(mix.keptLevels) : "all (effects kept)"],
      ["AAF", aaf ? aaf.path + (aaf.via === "cep" ? " (via the CEP bridge)" : "") : "not exported"]
    ];

    const notes = [];
    const groups = [];
    if (disabledRemoved.length) {
      groups.push(reportGroup({
        title: "Disabled audio removed", kind: "ok", total: disabledRemoved.length,
        lead: "Gaps were left in place rather than rippled, so sync is unchanged.",
        rows: clipRows(disabledRemoved, 6)
      }));
    }
    if (s.mixEffects === "remove" && mix.effectsRemoved) {
      notes.push("Removed " + mix.effectsRemoved + " audio effect(s): " +
        Object.keys(mix.removedNames).map((k) => k + " ×" + mix.removedNames[k]).join(", ") +
        ". Volume, Channel Volume and Pan are kept — they carry the edit's levels, not effects.");
    }
    if (s.mixEffects === "remove" && !mix.effectsRemoved) {
      notes.push("No audio effects to remove — every component on these clips was a level " +
        "or pan, which is kept.");
    }
    if (s.aafRenderAudioEffects && !fxIgnored) {
      notes.push("Audio effects are baked into the media the AAF writes, not into the Premiere " +
        "sequence — the mix timeline still shows them, and the AAF carries them rendered. " +
        "That is Premiere's Render and Replace.");
    }
    if (aaf && aaf.ignoredOptions && aaf.ignoredOptions.length) {
      notes.push("This Premiere's AAF exporter only writes new audio files when Breakout to Mono is " +
        "on. With it off, the AAF links your original media, so " + aaf.ignoredOptions.join(", ") +
        " had no effect. Turn on Breakout to Mono if the mixer needs rendered audio, or export " +
        "from Premiere 2026, which renders either way.");
    }
    if (s.aafMixdownVideo) {
      notes.push("Mixdown video is ON — expect a very large AAF and a video render beside it " +
        "(3 MB became 2.9 GB in testing). Mixers rarely want this.");
    }
    results.push({ title: "Mix", rows, warn: null, notes, groups });
  } catch (e) {
    try {
      await ppro.deleteSequenceById(clone.id);
      logLine("MIX rolled back half-built sequence " + outName);
      throw new Error((e.message || e) + " — the half-built \u201C" + outName +
                      "\u201D was removed, your source is untouched.");
    } catch (rollbackFailed) {
      if (!/half-built/.test(String(rollbackFailed.message || ""))) {
        throw new Error((e.message || e) + " — and the half-built \u201C" + outName +
                        "\u201D could NOT be removed; delete it by hand.");
      }
      throw rollbackFailed;
    }
  }
}

async function runProcess() {
  const blocked = processBlockReason();
  if (blocked) { setStatus(blocked, "warn"); return; }
  hideContinue();
  state.pendingGrade = null;
  const src = sourceName();
  if (!src) return;
  logLine("RUN START source=" + src + " ref=" + state.settings.refEnabled +
          " burnIn=" + state.settings.refBurnIn +
          " folder=" + (state.refFolder ? state.refFolder.path : "none"));
  const s = state.settings;

  state.busy = true;
  applyToggleState();
  setStatus("Processing…");

  const results = [];
  try {
    const plan = planOutputs();

    if (s.refEnabled) {
      setStatus("Building the reference export…");
      await runReferenceExport(plan, results);
    }
    if (s.gradeEnabled) {
      setStatus("Building the grade timeline…");
      await runGradeTimeline(plan, results);
    }
    if (s.mixEnabled) {
      setStatus("Building the mix timeline…");
      await runMixTimeline(plan, results);
    }

    showReport(renderRunReport(results));
    if (state.pendingGrade) {
      setStatus("Paused — " + state.pendingGrade.summary.multicam.length +
                " multicam clip(s) need flattening before the FCPXML.", "warn");
    } else {
      const warnings = results.filter((r) => r.warn);
      setStatus(warnings.length ? warnings.map((w) => w.warn).join(" ") : "Done.",
                warnings.length ? "warn" : "good");
    }
  } catch (e) {
    results.push({ title: "Run failed", rows: [["Error", String(e.message || e)]], warn: String(e.message || e) });
    showReport(renderRunReport(results));
    setStatus(String(e.message || e), "bad");
    logLine("RUN FAILED: " + (e.stack || e.message || e));
  } finally {
    state.busy = false;
    // The new sequence changes the collision picture for the next run.
    await refreshProject();
    applyToggleState();
  }
}

function renderRunReport(results) {
  return results.map((r) => {
    const cls = r.title === "Grade" ? " grade" : (r.title === "Mix" ? " mix" : "");
    return '<div class="card' + cls + '"><h3>' + escapeHtml(r.title) + "</h3>" +
      r.rows.map((row) => kv(row[0], row[1])).join("") +
      (r.warn ? '<div class="note warn">' + escapeHtml(r.warn) + "</div>" : "") +
      ((r.notes || []).map((n) => '<div class="note">' + escapeHtml(n) + "</div>").join("")) +
      ((r.groups || []).join("")) +
      "</div>";
  }).join("");
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function onControlChange() {
  state.settings = Object.assign({}, state.settings, readControls());
  prefs.save(state.settings);
  applyToggleState();
  renderPreviews();
}

function wire() {
  Object.keys(CONTROLS).forEach((id) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener("change", onControlChange);
    if (CONTROLS[id] === "text") el.addEventListener("input", onControlChange);
  });

  $("sourceSelect").addEventListener("change", (ev) => {
    state.sourceId = ev.target.value;
    renderPreviews();
    applyToggleState();
  });

  $("btnRefresh").addEventListener("click", () => {
    refreshProject();
    refreshCapabilities();
  });
  $("refPickFolder").addEventListener("click", () => pickFolder("refFolder"));
  $("gradePickFolder").addEventListener("click", () => pickFolder("gradeFolder"));
  $("mixPickFolder").addEventListener("click", () => pickFolder("mixFolder"));
  $("refPreset").addEventListener("change", () => {
    state.settings.refPresetPath = $("refPreset").value;
    prefs.save(state.settings);
  });
  $("btnContinue").addEventListener("click", continueGrade);
  $("btnSkipXml").addEventListener("click", skipXml);
  $("btnAnalyse").addEventListener("click", runAnalysis);
  $("btnProcess").addEventListener("click", runProcess);
}

async function boot() {
  writeControls(state.settings);
  wire();
  applyToggleState();
  await refreshCapabilities();
  await loadPresets();
  await refreshProject();
}

boot().catch((e) => setStatus("Startup failed: " + (e.message || e), "bad"));

// Test hook. The reveal/disable rules are the whole of Phase 1 and there is no
// way to click the panel from outside Premiere, so tests/toggle-test.js drives
// these against a mock DOM. Absent in the panel, where `module` is undefined.
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    state,
    applyToggleState,
    planOutputs,
    renderPreviews,
    renderAnalysis,
    binLine,
    effectiveSuffix,
    readControls,
    writeControls,
    continueGrade,
    skipXml,
    showContinue,
    hideContinue,
    multicamNote,
    reportGroup,
    clipRows
  };
}
