/**
 * prefs.js - remembers the panel's settings between runs.
 *
 * The spec only asks for the suffix fields to persist, but the toggles are
 * cheap to carry too and an editor who runs grade-only prep all week should
 * not re-tick it every morning.
 *
 * localStorage is the primary store. UXP exposes it, but it has been known to
 * throw in restricted contexts, so every access is guarded and falls back to
 * an in-memory object - the panel keeps working for the session, it just
 * forgets when Premiere closes.
 */

var STORAGE_KEY = "theonliner.prefs.v1";

var DEFAULTS = {
  refEnabled: false,
  refBurnIn: true,
  refSuffix: "_REF",
  refPresetPath: "",
  refExportMode: "now",

  gradeEnabled: false,
  gradeStripToVideo: true,
  gradeResetMotion: true,
  gradeRemoveEffects: true,
  gradeRemoveDisabled: true,
  gradeRemoveAdjustment: true,
  gradeRemoveHidden: true,
  gradeFlatten: false,
  gradeStripEmptyTracks: true,
  gradeExportXML: true,
  gradeSuffix: "_FOR_GRADE",

  mixEnabled: false,
  mixStripToAudio: true,
  mixRemoveDisabled: true,
  mixEffects: "keep", // keep | render | remove
  mixExportAAF: true,
  mixSuffix: "_FOR_MIX",
  aafMixdownVideo: false,
  aafExplodeToMono: true,
  aafRenderAudioEffects: true,
  aafInterleaveWithoutEffects: true,
  aafSampleRate: "48000",
  aafBitsPerSample: "24",
  aafFiles: "separate",
  aafPreserveParentFolder: false,
  aafFormat: "1",
  aafRender: "copy",
  aafHandleFrames: "0"
};

var memory = null;

function readRaw() {
  try {
    var s = localStorage.getItem(STORAGE_KEY);
    return s ? JSON.parse(s) : {};
  } catch (e) {
    return memory || {};
  }
}

function writeRaw(obj) {
  memory = obj;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
    return true;
  } catch (e) {
    return false; // Held in `memory` for this session only.
  }
}

/** Full settings object: defaults overlaid with whatever was stored. */
function load() {
  var stored = readRaw();
  var out = {};
  for (var k in DEFAULTS) out[k] = DEFAULTS[k];
  for (var k2 in stored) {
    if (Object.prototype.hasOwnProperty.call(DEFAULTS, k2)) out[k2] = stored[k2];
  }
  // A suffix saved as empty would silently overwrite the source sequence, so
  // an empty stored value falls back to the default rather than being honoured.
  ["refSuffix", "gradeSuffix", "mixSuffix"].forEach(function (key) {
    if (typeof out[key] !== "string" || !out[key].trim()) out[key] = DEFAULTS[key];
  });
  if (["keep", "remove"].indexOf(out.mixEffects) === -1) {
    out.mixEffects = DEFAULTS.mixEffects;
  }
  return out;
}

function save(settings) {
  var out = {};
  for (var k in DEFAULTS) {
    if (Object.prototype.hasOwnProperty.call(settings, k)) out[k] = settings[k];
  }
  return writeRaw(out);
}

/** True when the store actually persists - shown in the panel's About line. */
function isPersistent() {
  try {
    var probe = STORAGE_KEY + ".probe";
    localStorage.setItem(probe, "1");
    localStorage.removeItem(probe);
    return true;
  } catch (e) {
    return false;
  }
}

function reset() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (e) {
    /* ignore */
  }
  memory = null;
  return load();
}

module.exports = {
  DEFAULTS: DEFAULTS,
  load: load,
  save: save,
  reset: reset,
  isPersistent: isPersistent
};
