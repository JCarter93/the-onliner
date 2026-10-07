/**
 * Tests for the CEP bridge - the FCPXML/AAF export route for Premiere 25.x,
 * whose UXP API has no ProjectConverter.
 *
 * Three files, three layers:
 *   cep-bridge/js/queue.js     the protocol: paths, request validation, the
 *                              ExtendScript call a request becomes
 *   cep-bridge/host/exports.jsx  the ExtendScript itself, run here against a
 *                              fake `app` - it is plain ES3, so jsc runs it
 *   js/cepbridge.js            the panel's client: heartbeat, wait verdicts,
 *                              which AAF options 25.x ignores
 *
 * The live half - that Premiere 25.6.6 accepts these exact calls - is in
 * docs/API-FINDINGS.md section 22. What is pinned here is that the code still
 * makes those calls: argument ORDER for exportAAF (14 positional arguments,
 * every flag 1/0) is exactly the kind of thing a tidy-up breaks silently.
 */

function load(file) {
  var module = { exports: {} };
  (new Function("module", "exports", "require", readFile(file)))(
    module, module.exports, function (name) { throw new Error("no host module: " + name); });
  return module.exports;
}

var Q = load("cep-bridge/js/queue.js");
var C = load("js/cepbridge.js");

var passed = 0, failed = 0;
function eq(actual, expected, label) {
  var a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) passed++;
  else { failed++; print("FAIL  " + label + "\n      expected " + e + "\n      got      " + a); }
}
function ok(cond, label) { if (cond) passed++; else { failed++; print("FAIL  " + label); } }

// --- queue.js: where the queue lives ---------------------------------------

eq(Q.hostMajor("25.6.6"), "25", "major from a full version");
eq(Q.hostMajor("26.3.2"), "26", "2026 gets its own queue");
eq(Q.hostMajor(""), null, "no version, no major - not a guess");
eq(Q.hostMajor(null), null, "null version");

eq(Q.versionRoot("darwin", "/Users/ed", null, "25"),
   "/Users/ed/Library/Application Support/Adobe/UXP/PluginsStorage/PPRO/25",
   "Mac root is UXP's PluginsStorage, per major");
eq(Q.versionRoot("win32", null, "C:\\Users\\ed\\AppData\\Roaming", "25"),
   "C:\\Users\\ed\\AppData\\Roaming\\Adobe\\UXP\\PluginsStorage\\PPRO\\25",
   "Windows root is under %APPDATA%, backslashes throughout");
eq(Q.versionRoot("win32", "C:\\Users\\ed", null, "25"), null, "Windows without APPDATA is null, not a Mac path");
eq(Q.versionRoot("darwin", "/Users/ed", null, null), null, "no major, no root");
eq(Q.queueDirFor("/R/PPRO/25", "External", "darwin"),
   "/R/PPRO/25/External/theonliner/PluginData/cep-queue", "queue sits in the panel's own data folder");
eq(Q.QUEUE_DIR, C.QUEUE_DIR, "bridge and panel agree on the queue folder name");

// --- queue.js: what a request may be ---------------------------------------

ok(Q.isRequestName("req-1791382495314-4821.json"), "a panel request name");
ok(!Q.isRequestName("tmp-1791382495314-4821.json"), "a request still being written is not served");
ok(!Q.isRequestName("req-1.taken"), "a claimed request is not served twice");
ok(!Q.isRequestName("req-../../x.json"), "no path tricks in the name");

var good = JSON.stringify({ id: "17-5", kind: "exportFCPXML",
  params: { sequenceId: "abc", sequenceName: "Seq", outputPath: "/out/Seq.xml" } });
eq(Q.parseRequest(good).ok, true, "a well-formed FCPXML request");
eq(Q.parseRequest("{\"id\":\"17-5\",\"ki").parseError, true, "half-written JSON is flagged as such, to be retried");
eq(Q.parseRequest(JSON.stringify({ id: "17-5", kind: "eval", params: {} })).error, "unknown kind: eval",
   "only the two export kinds - nothing else becomes ExtendScript");
eq(Q.parseRequest(JSON.stringify({ id: "x y", kind: "exportAAF", params: {} })).error, "bad id", "id is constrained");
eq(Q.parseRequest(JSON.stringify({ id: "1", kind: "exportAAF", params: { sequenceId: "a" } })).error,
   "outputPath missing", "no path, no export");
eq(Q.parseRequest(JSON.stringify({ id: "1", kind: "exportAAF", params: { outputPath: "/x.aaf" } })).error,
   "sequenceId missing", "no sequence, no export");

// --- queue.js: the call a request becomes ----------------------------------

var call = Q.buildEvalScript({ id: "1", kind: "exportFCPXML",
  params: { sequenceId: "g-1", sequenceName: "A \"quoted\" name", outputPath: "C:\\out\\a.xml", extra: "dropped" } });
ok(call.indexOf("onlinerBridge_exportFCPXML({") === 0, "FCPXML maps to its host function");
ok(call.indexOf("extra") < 0, "fields outside the whitelist are not passed through");
ok(call.indexOf("C:\\\\out\\\\a.xml") > 0, "backslashes survive as escapes, not as ES3 escape sequences");

var aafCall = Q.buildEvalScript({ id: "1", kind: "exportAAF", params: { sequenceId: "g", outputPath: "/m.aaf",
  options: { explodeToMono: 1, trimSources: "yes", handleFrames: "25.7", sampleRate: "96000", audioFileFormat: 0, rogue: 1 } } });
var aafArgs = JSON.parse(aafCall.slice(aafCall.indexOf("(") + 1, -1));
eq(aafArgs.options.explodeToMono, true, "flags normalised to booleans");
eq(aafArgs.options.trimSources, true, "truthy strings are flags too");
eq(aafArgs.options.handleFrames, 25, "handle frames whole and non-negative");
eq(aafArgs.options.sampleRate, 96000, "sample rate numeric");
eq(aafArgs.options.audioFileFormat, 0, "AIFF stays 0");
eq(aafArgs.options.rogue, undefined, "unknown AAF options dropped");
eq(Q.buildEvalScript({ id: "1", kind: "exportAAF", params: { sequenceId: "g", outputPath: "/m.aaf" } })
     .indexOf("\"audioFileFormat\":1") > 0, true, "Broadcast Wave by default");

eq(Q.parseHostResult("EvalScript error.").ok, false, "CEP's error string is an error, not data");
eq(Q.parseHostResult("{\"ok\":true,\"exported\":true}").exported, true, "a host answer parses");
eq(Q.parseHostResult("undefined").ok, false, "a missing return is an error");

var hb = Q.heartbeat(10000, "25.6.6", { exportFCPXML: true }, "exportAAF x.aaf", 4000, 77);
eq([hb.lastSeen, hb.busySeconds, hb.appVersion], [10, 6, "25.6.6"], "heartbeat is in seconds, with busy time");

// --- exports.jsx against a fake Premiere ------------------------------------

var calls = [];
function fakeSeq(id, name) {
  return { sequenceID: id, name: name,
    exportAsFinalCutProXML: function (p, ui) { calls.push(["xml", name, p, ui]); return true; } };
}
var seqList = [fakeSeq("AAAA-1", "Grade"), fakeSeq("BBBB-2", "Twin"), fakeSeq("CCCC-3", "Twin")];
seqList.numSequences = 3;
var app = { version: "25.6.6", project: { sequences: seqList,
  exportAAF: function () { calls.push(["aaf"].concat(Array.prototype.slice.call(arguments, 1))); return 1; } } };
(new Function("app", readFile("cep-bridge/host/exports.jsx") +
  "\nthis.X = { xml: onlinerBridge_exportFCPXML, aaf: onlinerBridge_exportAAF, caps: onlinerBridge_capabilities };"
)).call(this, app);
var X = this.X;

var r = JSON.parse(X.xml({ sequenceId: "aaaa-1", sequenceName: "", outputPath: "/o/g.xml" }));
eq([r.ok, r.matchedBy, calls[0]], [true, "id", ["xml", "Grade", "/o/g.xml", 1]], "GUID match, case-insensitive, UI suppressed");
r = JSON.parse(X.xml({ sequenceId: "nope", sequenceName: "Grade", outputPath: "/o/g.xml" }));
eq([r.ok, r.matchedBy], [true, "name"], "a GUID miss falls back to a UNIQUE name");
r = JSON.parse(X.xml({ sequenceId: "nope", sequenceName: "Twin", outputPath: "/o/t.xml" }));
eq(r.ok, false, "an ambiguous name is refused, never guessed");
ok(/More than one/.test(r.error), "and says why");
eq(JSON.parse(X.xml({ sequenceId: "nope", sequenceName: "Gone", outputPath: "/o/x.xml" })).ok, false, "a missing sequence is an error");

calls = [];
r = JSON.parse(X.aaf({ sequenceId: "AAAA-1", outputPath: "/o/m.aaf", options: {
  mixdownVideo: false, explodeToMono: true, sampleRate: 96000, bitsPerSample: 16, embedAudio: true,
  audioFileFormat: 0, trimSources: true, handleFrames: 25, renderAudioEffects: true,
  interleaveWithoutEffects: false, preserveParentFolder: true } }));
eq(r.ok, true, "AAF export answers");
// (sequence, path, mixDownVideo, explodeToMono, sampleRate, bitsPerSample, embedAudio,
//  audioFileFormat, trimSources, handleFrames, presetPath, renderAudioEffects,
//  includeClipCopies, preserveParentFolder) - the order proven on 25.6.6.
eq(calls[0], ["aaf", "/o/m.aaf", 0, 1, 96000, 16, 1, 0, 1, 25, "", 1, 0, 1],
   "exportAAF gets 14 positional arguments, flags as 1/0, in the proven order");
calls = [];
X.aaf({ sequenceId: "AAAA-1", outputPath: "/o/d.aaf" });
eq(calls[0], ["aaf", "/o/d.aaf", 0, 0, 48000, 24, 0, 1, 0, 0, "", 0, 0, 0], "defaults: 48k/24-bit Broadcast Wave, all flags 0");

var caps = JSON.parse(X.caps());
eq([caps.exportFCPXML, caps.exportAAF, caps.appVersion], [true, true, "25.6.6"], "capabilities reported from the host");
eq(JSON.parse(X.xml({ sequenceId: "AAAA-1", sequenceName: "", outputPath: "/o/\"q\"\n.xml" })).ok, true,
   "the hand-rolled serializer survives quotes and control characters");

// --- js/cepbridge.js: the panel's client ------------------------------------

ok(C.isFresh({ lastSeen: 100 }, 110), "a 10s-old heartbeat is alive");
ok(!C.isFresh({ lastSeen: 100 }, 130), "a 30s-old heartbeat is dead");
ok(!C.isFresh(null, 100), "no heartbeat is not alive");

var W = { sawBusy: false, sinceStartMs: 1000, sinceAliveMs: 0, pickupMs: 15000, idleMs: 20000, hardCapMs: 3600000 };
function w(over) { var o = {}; for (var k in W) o[k] = W[k]; for (k in over) o[k] = over[k]; return o; }
eq(C.waitVerdict({ running: true, busy: "exportAAF" }, w({ sinceStartMs: 600000 })), "waiting",
   "a long render with a live heartbeat is waited for, however long");
eq(C.waitVerdict({ running: true, busy: null }, w({})), "waiting", "just written, not yet picked up");
eq(C.waitVerdict({ running: true, busy: null }, w({ sinceStartMs: 16000 })), "dropped", "alive, idle and never picked up");
eq(C.waitVerdict({ running: true, busy: null }, w({ sawBusy: true })), "dropped", "was busy, now idle with no answer");
eq(C.waitVerdict({ running: false }, w({ sinceAliveMs: 21000 })), "dead", "heartbeat gone past the idle window");
eq(C.waitVerdict({ running: false }, w({ sinceAliveMs: 5000 })), "waiting", "a blip in the heartbeat is not death");

eq(C.ignoredAafOptions({ trimSources: true, embedAudio: true, renderAudioEffects: true }),
   ["Trim Audio Files", "Embedded Audio", "Render audio clip effects"],
   "without Breakout to Mono, 25.x links original media and ignores all three");
eq(C.ignoredAafOptions({ explodeToMono: true, trimSources: true, embedAudio: true }), [],
   "with Breakout to Mono, 25.x renders - and honours trim");
eq(C.ignoredAafOptions({}), [], "nothing asked, nothing ignored");

print((failed ? "FAILED " : "ok ") + passed + " passed, " + failed + " failed");
if (failed) throw new Error(failed + " failed");
