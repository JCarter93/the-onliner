/**
 * cepbridge.js - the panel's side of the CEP bridge, the export route for
 * Premiere builds whose UXP API has no ProjectConverter (25.x).
 *
 * On those builds UXP cannot write an FCPXML or an AAF at all, but
 * ExtendScript can, and a UXP panel has no way to call ExtendScript. So a
 * small headless CEP extension (cep-bridge/, installed beside the panel) runs
 * the export for us, and the two talk through a folder in this panel's own
 * data folder - no picker, no permission prompt, no network:
 *
 *    panel   writes  cep-queue/req-<id>.json    { id, kind, params }
 *    bridge  writes  cep-queue/res-<id>.json    { id, ok, result | error }
 *    bridge  writes  cep-queue/status.json      every 2s, as a heartbeat
 *
 * Same protocol as The Conformer's helper, and the same rule for waiting:
 * wait on the HEARTBEAT, not on a stopwatch. An AAF that renders media can take
 * minutes, and a fixed timeout has to guess how long the longest job takes.
 *
 * Only ppro.js calls this, and only when the native UXP export is missing.
 */

var QUEUE_DIR = "cep-queue";
var HEARTBEAT_STALE_SECONDS = 15;
var POLL_MS = 400;

function uxpFs() {
  return require("uxp").storage.localFileSystem;
}

async function queueFolder() {
  const data = await uxpFs().getDataFolder();
  try {
    return await data.getEntry(QUEUE_DIR);
  } catch (e) {
    return await data.createFolder(QUEUE_DIR);
  }
}

async function readJson(folder, name) {
  try {
    const entry = await folder.getEntry(name);
    return JSON.parse(await entry.read());
  } catch (e) {
    return null;
  }
}

/** Is the bridge alive? Judged by its heartbeat, not by its mere existence. */
function isFresh(status, nowSeconds) {
  if (!status || typeof status.lastSeen !== "number") return false;
  return (nowSeconds - status.lastSeen) < HEARTBEAT_STALE_SECONDS;
}

/**
 * What the bridge says it can do. `running` false covers both "not installed"
 * and "installed but Premiere has not started it" - the panel cannot tell
 * those apart, so the message names the one fix that covers both.
 */
async function status() {
  try {
    const folder = await queueFolder();
    const raw = await readJson(folder, "status.json");
    const now = Date.now() / 1000;
    const running = isFresh(raw, now);
    return {
      running,
      version: raw ? raw.version : null,
      appVersion: raw ? raw.appVersion : null,
      caps: running && raw.caps ? raw.caps : null,
      busy: raw ? raw.busy : null,
      secondsSinceHeartbeat: raw && typeof raw.lastSeen === "number" ? Math.round(now - raw.lastSeen) : null
    };
  } catch (e) {
    return { running: false, error: String(e.message || e) };
  }
}

/**
 * Should we keep waiting, and if not, why not? Pure, so every way a wait can
 * end is testable without a bridge or a Premiere.
 */
function waitVerdict(live, w) {
  if (live && live.running && live.busy) return "waiting";
  // Alive and idle while our answer never came: claimed and lost (a Premiere
  // restart mid-job), or never picked up at all.
  if (live && live.running && (w.sawBusy || w.sinceStartMs > w.pickupMs)) return "dropped";
  if (live && !live.running && w.sinceAliveMs > w.idleMs) return "dead";
  if (w.sinceStartMs > w.hardCapMs) return "capped";
  return "waiting";
}

function newId() {
  return String(Date.now()) + "-" + Math.floor(Math.random() * 100000);
}

var NOT_RUNNING = "This Premiere's plugin API cannot export it, and the CEP bridge that does it " +
  "instead is not running. Install it with scripts/install-dev (.sh on a Mac, .ps1 on Windows) " +
  "and restart Premiere - it starts on its own, there is no panel to open.";

/** Send one request and wait for the answer. */
async function request(kind, params, opts) {
  const o = opts || {};
  const idleMs = o.idleMs || 20 * 1000;
  const pickupMs = o.pickupMs || 15 * 1000;
  const hardCapMs = o.hardCapMs || 60 * 60 * 1000;

  const live = await status();
  if (!live.running) throw new Error(NOT_RUNNING);

  const folder = await queueFolder();
  const id = newId();
  // Written under a name the bridge ignores, then renamed, so it can never
  // claim a half-written request. If this UXP build will not rename, write in
  // place: the bridge leaves a young file that will not parse alone anyway.
  const body = JSON.stringify({ id: id, kind: kind, params: params || {} });
  const tmp = await folder.createFile("tmp-" + id + ".json", { overwrite: true });
  await tmp.write(body);
  try {
    await tmp.moveTo(folder, { newName: "req-" + id + ".json", overwrite: true });
  } catch (e) {
    const direct = await folder.createFile("req-" + id + ".json", { overwrite: true });
    await direct.write(body);
    try { await tmp.delete(); } catch (e2) { /* harmless leftover */ }
  }

  const started = Date.now();
  let lastAlive = Date.now();
  let sawBusy = false;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    let res = await readJson(folder, "res-" + id + ".json");
    if (!res) {
      const now = await status();
      if (now.running) lastAlive = Date.now();
      if (now.running && now.busy) sawBusy = true;
      const verdict = waitVerdict(now, {
        sawBusy, sinceStartMs: Date.now() - started, sinceAliveMs: Date.now() - lastAlive,
        pickupMs, idleMs, hardCapMs
      });
      if (verdict !== "waiting") {
        res = await readJson(folder, "res-" + id + ".json");   // it may have just landed
        if (!res) {
          if (verdict === "dropped") throw new Error("The CEP bridge took the export request but never answered - Premiere may have restarted. Nothing was exported; run again.");
          if (verdict === "dead") throw new Error("The CEP bridge stopped responding" + (sawBusy ? " during the export" : "") + ". Its log is bridge.log in " + folder.nativePath + ".");
          throw new Error("The CEP bridge has been exporting for " + Math.round(hardCapMs / 60000) + " minutes without finishing.");
        }
      }
    }
    if (res) {
      try { await (await folder.getEntry("res-" + id + ".json")).delete(); } catch (e) { /* the bridge tidies */ }
      if (!res.ok) throw new Error("The CEP bridge could not export: " + (res.error || "no reason given"));
      return res.result || {};
    }
  }
}

/**
 * AAF options the ExtendScript exporter does not act on, as labels for the
 * report. Measured on Premiere 25.6.6 (docs/API-FINDINGS.md §22): it writes
 * new audio files ONLY when Breakout to Mono is on. With it off the AAF links
 * the original media, and Trim, Embedded and Render audio clip effects change
 * nothing - byte-identical files. With it on, Trim is honoured (2,188s of
 * audio became 175s) and Embedded embeds. The 26.x UXP exporter renders in
 * every case, so this is a 25.x difference the editor needs to see.
 */
function ignoredAafOptions(opts) {
  const o = opts || {};
  if (o.explodeToMono) return [];
  const out = [];
  if (o.trimSources) out.push("Trim Audio Files");
  if (o.embedAudio) out.push("Embedded Audio");
  if (o.renderAudioEffects) out.push("Render audio clip effects");
  return out;
}

module.exports = { status, request, isFresh, waitVerdict, ignoredAafOptions, QUEUE_DIR, NOT_RUNNING };
