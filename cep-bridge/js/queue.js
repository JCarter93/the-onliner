/**
 * queue.js - the pure half of the CEP bridge: where the queue lives, what a
 * valid request looks like, and how a request becomes an ExtendScript call.
 *
 * No file access and no host calls here, so the whole protocol is testable
 * under jsc (tests/cepbridge-test.js). main.js does the I/O.
 *
 * The queue is a folder inside The Onliner's OWN UXP data folder - the one
 * place the panel can write without a picker or a permission prompt (the same
 * arrangement The Conformer uses for its helper):
 *
 *   <PluginsStorage>/PPRO/<major>/<origin>/theonliner/PluginData/cep-queue/
 *
 * <major> is Premiere's major version, so a 2025 and a 2026 running side by
 * side never answer each other's requests. <origin> is "External" for a dev
 * install; it is scanned rather than assumed, so a packaged install works too.
 */

var PLUGIN_ID = "theonliner";
var QUEUE_DIR = "cep-queue";
var BRIDGE_VERSION = "1.0.0";
var KINDS = { exportFCPXML: "onlinerBridge_exportFCPXML", exportAAF: "onlinerBridge_exportAAF" };

// A request file younger than this that will not parse is assumed to be
// mid-write and left alone; older than this it is answered as malformed.
var HALF_WRITTEN_MS = 10000;

/** "25.6.6" -> "25". Null for anything that does not start with a number. */
function hostMajor(appVersion) {
  var m = /^\s*(\d+)/.exec(String(appVersion || ""));
  return m ? m[1] : null;
}

/**
 * UXP's PluginsStorage root for this user. `appData` is %APPDATA% on Windows;
 * `home` is the home folder on a Mac. Null when the one it needs is missing.
 */
function pluginsStorageRoot(platformName, home, appData) {
  if (platformName === "win32") {
    return appData ? [appData, "Adobe", "UXP", "PluginsStorage"].join("\\") : null;
  }
  return home ? [home, "Library", "Application Support", "Adobe", "UXP", "PluginsStorage"].join("/") : null;
}

/** The folder holding one origin folder per install route, for this major. */
function versionRoot(platformName, home, appData, major) {
  var root = pluginsStorageRoot(platformName, home, appData);
  if (!root || !major) return null;
  var sep = platformName === "win32" ? "\\" : "/";
  return [root, "PPRO", major].join(sep);
}

/** <origin>/theonliner/PluginData/cep-queue under a version root. */
function queueDirFor(versionRootPath, origin, platformName) {
  var sep = platformName === "win32" ? "\\" : "/";
  return [versionRootPath, origin, PLUGIN_ID, "PluginData", QUEUE_DIR].join(sep);
}

function isRequestName(name) {
  return /^req-[A-Za-z0-9-]{1,64}\.json$/.test(String(name));
}

/**
 * Validate a request file's text. Returns { ok, request } or { ok:false, error }.
 * Strict on purpose: the bridge turns this into an ExtendScript call, so
 * anything it does not recognise is refused rather than passed through.
 */
function parseRequest(text) {
  var req;
  try { req = JSON.parse(String(text)); } catch (e) { return { ok: false, error: "not JSON", parseError: true }; }
  if (!req || typeof req !== "object") return { ok: false, error: "not an object" };
  if (typeof req.id !== "string" || !/^[A-Za-z0-9-]{1,64}$/.test(req.id)) return { ok: false, error: "bad id" };
  if (!Object.prototype.hasOwnProperty.call(KINDS, req.kind)) {
    return { ok: false, id: req.id, error: "unknown kind: " + String(req.kind) };
  }
  var p = req.params || {};
  if (typeof p.outputPath !== "string" || !p.outputPath) return { ok: false, id: req.id, error: "outputPath missing" };
  if (typeof p.sequenceId !== "string" || !p.sequenceId) return { ok: false, id: req.id, error: "sequenceId missing" };
  if (p.sequenceName !== undefined && typeof p.sequenceName !== "string") {
    return { ok: false, id: req.id, error: "sequenceName must be a string" };
  }
  return { ok: true, request: req };
}

/**
 * The ExtendScript call for a validated request. Only whitelisted fields are
 * copied, and JSON.stringify output is a valid ES3 object literal, so nothing
 * in a request can become code.
 */
function buildEvalScript(req) {
  var p = req.params || {};
  var args = { sequenceId: p.sequenceId, sequenceName: p.sequenceName || "", outputPath: p.outputPath };
  if (req.kind === "exportAAF") {
    var o = p.options || {};
    args.options = {
      mixdownVideo: !!o.mixdownVideo,
      explodeToMono: !!o.explodeToMono,
      sampleRate: Number(o.sampleRate) || 48000,
      bitsPerSample: Number(o.bitsPerSample) || 24,
      embedAudio: !!o.embedAudio,
      audioFileFormat: o.audioFileFormat === 0 ? 0 : 1,
      trimSources: !!o.trimSources,
      handleFrames: Math.max(0, Math.floor(Number(o.handleFrames) || 0)),
      renderAudioEffects: !!o.renderAudioEffects,
      interleaveWithoutEffects: !!o.interleaveWithoutEffects,
      preserveParentFolder: !!o.preserveParentFolder
    };
  }
  return KINDS[req.kind] + "(" + JSON.stringify(args) + ")";
}

/**
 * What evalScript handed back. CEP reports a script error as the literal
 * string "EvalScript error." - not an exception - so that is checked first.
 */
function parseHostResult(raw) {
  var s = String(raw === undefined ? "" : raw);
  if (s === "EvalScript error.") return { ok: false, error: "ExtendScript error - the bridge's host script did not load or threw." };
  try {
    var r = JSON.parse(s);
    if (r && typeof r === "object") return r;
  } catch (e) { /* fall through */ }
  return { ok: false, error: "Unreadable answer from ExtendScript: " + s.slice(0, 200) };
}

/** Heartbeat content. Seconds, to match The Conformer's helper. */
function heartbeat(nowMs, appVersion, caps, busy, busySinceMs, pid) {
  return {
    bridge: "onliner-cep",
    version: BRIDGE_VERSION,
    lastSeen: nowMs / 1000,
    appVersion: appVersion || null,
    caps: caps || null,
    busy: busy || null,
    busySeconds: busy && busySinceMs ? Math.round((nowMs - busySinceMs) / 1000) : null,
    pid: pid || null
  };
}

var api = {
  PLUGIN_ID: PLUGIN_ID, QUEUE_DIR: QUEUE_DIR, BRIDGE_VERSION: BRIDGE_VERSION, KINDS: KINDS,
  HALF_WRITTEN_MS: HALF_WRITTEN_MS,
  hostMajor: hostMajor, pluginsStorageRoot: pluginsStorageRoot, versionRoot: versionRoot,
  queueDirFor: queueDirFor, isRequestName: isRequestName, parseRequest: parseRequest,
  buildEvalScript: buildEvalScript, parseHostResult: parseHostResult, heartbeat: heartbeat
};
// Both, deliberately: CEP's mixed context defines `module` in the page too, so
// "one or the other" would hide the API from main.js there.
if (typeof module !== "undefined" && module && module.exports) module.exports = api;
if (typeof window !== "undefined") window.OnlinerQueue = api;
