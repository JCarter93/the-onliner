/**
 * main.js - the CEP bridge's I/O loop. Runs headless inside Premiere (no panel,
 * no window) from the moment Premiere starts, and does one thing: answers The
 * Onliner's FCPXML and AAF export requests through ExtendScript, on builds whose
 * UXP API cannot do them itself (Premiere 25.x - docs/API-FINDINGS.md §22).
 *
 * Protocol, the same shape as The Conformer's helper:
 *
 *   panel   writes  cep-queue/req-<id>.json    { id, kind, params }
 *   bridge  renames it to .taken (the claim - atomic, so nothing runs twice)
 *   bridge  writes  cep-queue/res-<id>.json    { id, ok, result | error }
 *   bridge  writes  cep-queue/status.json      every 2s, the heartbeat
 *
 * Responses and the heartbeat go through `.part` + rename, so the panel never
 * reads half a file. Everything that can be pure lives in queue.js.
 */
(function () {
  "use strict";

  var fs = require("fs");
  var os = require("os");
  var path = require("path");
  var Q = window.OnlinerQueue;
  var cep = window.__adobe_cep__;

  var POLL_MS = 500;
  var HEARTBEAT_MS = 2000;
  var DISCOVER_MS = 5000;
  var CAPS_MS = 30000;
  var KEEP_MS = 24 * 3600 * 1000;      // answered requests are tidied after a day
  var LOG_MAX = 256 * 1024;

  var env = {};
  try { env = JSON.parse(cep.getHostEnvironment()); } catch (e) { env = {}; }
  var appVersion = env.appVersion || null;
  var major = Q.hostMajor(appVersion);
  var root = Q.versionRoot(process.platform, os.homedir(), process.env.APPDATA, major);

  var queues = [];          // queue folders currently being served
  var caps = null;
  var busy = null, busySince = 0;
  var lastDiscover = 0, lastBeat = 0, lastCaps = 0, lastTidy = 0;

  function now() { return Date.now(); }

  function log(text) {
    queues.forEach(function (dir) {
      try {
        var file = path.join(dir, "bridge.log");
        try { if (fs.statSync(file).size > LOG_MAX) fs.renameSync(file, file + ".1"); } catch (e) {}
        fs.appendFileSync(file, new Date().toISOString() + "  " + text + "\n");
      } catch (e) { /* logging must never break the bridge */ }
    });
  }

  function writeAtomic(file, value) {
    var part = file + ".part";
    fs.writeFileSync(part, JSON.stringify(value, null, 1));
    fs.renameSync(part, file);
  }

  function evalScript(script) {
    return new Promise(function (resolve) { cep.evalScript(script, resolve); });
  }

  /** The extension's own folder, from CEP's file URL. */
  function extensionDir() {
    var p = String(cep.getSystemPath("extension") || "");
    p = p.replace(/^file:\/\/\//, process.platform === "win32" ? "" : "/").replace(/^file:\/\//, "");
    return decodeURI(p);
  }

  /**
   * ScriptPath in the manifest loads exports.jsx at start-up. If the functions
   * are missing anyway (a host that skipped it, an ExtendScript engine reset),
   * load the file by hand once and try again.
   */
  function refreshCaps() {
    return evalScript("onlinerBridge_capabilities()").then(function (raw) {
      var r = Q.parseHostResult(raw);
      if (r.ok === false) {
        var jsx = path.join(extensionDir(), "host", "exports.jsx");
        return evalScript("$.evalFile(" + JSON.stringify(jsx) + ")")
          .then(function () { return evalScript("onlinerBridge_capabilities()"); })
          .then(function (raw2) { return Q.parseHostResult(raw2); });
      }
      return r;
    }).then(function (r) {
      caps = r && r.ok !== false ? { exportFCPXML: !!r.exportFCPXML, exportAAF: !!r.exportAAF } : null;
      if (!caps) log("capabilities unavailable: " + (r && r.error));
    });
  }

  /** Every <origin>/theonliner/PluginData under this major gets a queue. */
  function discover() {
    if (!root) return;
    var found = [];
    var origins = [];
    try { origins = fs.readdirSync(root); } catch (e) { origins = []; }
    origins.forEach(function (origin) {
      var dataDir = path.join(root, origin, Q.PLUGIN_ID, "PluginData");
      try {
        if (!fs.statSync(dataDir).isDirectory()) return;
      } catch (e) { return; }
      var q = path.join(dataDir, Q.QUEUE_DIR);
      try { fs.mkdirSync(q, { recursive: true }); found.push(q); } catch (e) {}
    });
    var added = found.filter(function (q) { return queues.indexOf(q) < 0; });
    queues = found;
    if (added.length) log("serving " + added.join(", ") + " for Premiere " + appVersion);
  }

  function beat() {
    var hb = Q.heartbeat(now(), appVersion, caps, busy, busySince, process.pid);
    queues.forEach(function (dir) {
      try { writeAtomic(path.join(dir, "status.json"), hb); } catch (e) {}
    });
  }

  function tidy(dir) {
    var cutoff = now() - KEEP_MS;
    try {
      fs.readdirSync(dir).forEach(function (name) {
        if (!/^(req|res)-.*\.(taken|bad|json)$/.test(name) || Q.isRequestName(name)) return;
        var file = path.join(dir, name);
        try { if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file); } catch (e) {}
      });
    } catch (e) {}
  }

  /** What the export left on disk - the answer that matters, not the return value. */
  function inspectOutput(outputPath) {
    var out = { fileExists: false, bytes: 0, mediaFiles: null };
    try {
      var st = fs.statSync(outputPath);
      out.fileExists = st.isFile();
      out.bytes = st.size;
    } catch (e) {}
    try {
      out.mediaFiles = fs.readdirSync(path.join(path.dirname(outputPath), "AAF Media")).length;
    } catch (e) { out.mediaFiles = null; }
    return out;
  }

  function serve(dir, name) {
    var file = path.join(dir, name);
    var text, age;
    try {
      text = fs.readFileSync(file, "utf8");
      age = now() - fs.statSync(file).mtimeMs;
    } catch (e) { return Promise.resolve(); }

    var parsed = Q.parseRequest(text);
    if (!parsed.ok && parsed.parseError && age < Q.HALF_WRITTEN_MS) return Promise.resolve();

    var id = parsed.ok ? parsed.request.id : (parsed.id || name.replace(/^req-|\.json$/g, ""));
    var resFile = path.join(dir, "res-" + id + ".json");
    var claimed = path.join(dir, "req-" + id + ".taken");
    try { fs.renameSync(file, parsed.ok ? claimed : path.join(dir, "req-" + id + ".bad")); }
    catch (e) { return Promise.resolve(); }   // someone else claimed it

    if (!parsed.ok) {
      writeAtomic(resFile, { id: id, ok: false, error: "Request refused: " + parsed.error });
      log("refused " + name + ": " + parsed.error);
      return Promise.resolve();
    }

    var req = parsed.request;
    busy = req.kind + " " + path.basename(req.params.outputPath);
    busySince = now();
    beat();
    log("start " + id + " " + busy);
    return evalScript(Q.buildEvalScript(req)).then(function (raw) {
      var r = Q.parseHostResult(raw);
      var answer;
      if (r.ok === false) {
        answer = { id: id, ok: false, error: r.error };
      } else {
        var disk = inspectOutput(req.params.outputPath);
        r.fileExists = disk.fileExists;
        r.bytes = disk.bytes;
        if (req.kind === "exportAAF") r.mediaFiles = disk.mediaFiles;
        answer = { id: id, ok: true, result: r, appVersion: appVersion,
                   seconds: Math.round((now() - busySince) / 100) / 10 };
      }
      writeAtomic(resFile, answer);
      log("done " + id + " ok=" + answer.ok + " " + (answer.ok ? JSON.stringify(answer.result) : answer.error));
    }).catch(function (e) {
      writeAtomic(resFile, { id: id, ok: false, error: "Bridge failure: " + (e && e.message || e) });
    }).then(function () { busy = null; busySince = 0; beat(); });
  }

  var working = false;
  function tick() {
    var t = now();
    if (t - lastDiscover > DISCOVER_MS) { discover(); lastDiscover = t; }
    if (t - lastCaps > CAPS_MS && !working) { lastCaps = t; refreshCaps(); }
    if (t - lastBeat > HEARTBEAT_MS) { beat(); lastBeat = t; }
    if (t - lastTidy > 3600 * 1000) { queues.forEach(tidy); lastTidy = t; }
    if (working) return;

    // One job at a time: ExtendScript is single-threaded and an AAF can take
    // minutes. Oldest request first.
    for (var i = 0; i < queues.length; i++) {
      var names = [];
      try { names = fs.readdirSync(queues[i]).filter(Q.isRequestName).sort(); } catch (e) { continue; }
      if (names.length) {
        working = true;
        serve(queues[i], names[0]).then(function () { working = false; }, function () { working = false; });
        return;
      }
    }
  }

  if (!major || !root) {
    // Nothing to serve without a version or a home folder; stay inert.
    return;
  }
  discover();
  refreshCaps().then(beat);
  setInterval(tick, POLL_MS);
})();
