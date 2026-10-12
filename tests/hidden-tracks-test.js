/**
 * Clips on a hidden video track / muted audio track are taken out of the
 * handoff, the same as disabled clips.
 *
 * Measured on a 9:16 test cut (Windows 25.6.6): a clip on hidden V2 was
 * flattened onto V1 of the grade timeline and would have been graded, although
 * nothing on that track reaches the programme. Driven here through the real
 * ppro.js against a fake host, which records what was removed and how.
 */
var passed = 0, failed = 0;
function eq(actual, expected, label) {
  if (actual === expected) passed++;
  else { failed++; print("FAIL  " + label + "\n      expected " + expected + "\n      got      " + actual); }
}

function clip(name, disabled) {
  return { name: name, getName: async function () { return name; },
           isDisabled: async function () { return !!disabled; } };
}
function track(muted, clips) {
  return { clips: clips, isMuted: async function () { return muted; },
           getTrackItems: async function () { return clips.slice(); } };
}
var video = [track(false, [clip("V1a"), clip("V1b")]), track(true, [clip("V2a"), clip("V2b")]),
             track(false, [clip("V3off", true)])];
var audio = [track(false, [clip("A1a")]), track(true, [clip("A2scratch")])];
var removals = [];
var sequence = {
  getVideoTrackCount: async function () { return video.length; },
  getAudioTrackCount: async function () { return audio.length; },
  getVideoTrack: async function (i) { return video[i]; },
  getAudioTrack: async function (i) { return audio[i]; }
};
var host = {
  Project: { getActiveProject: async function () {
    return {
      getSequence: async function () { return sequence; },
      lockedAccess: function (fn) { fn(); },
      executeTransaction: function (fn, label) { var acts = []; fn({ addAction: function (a) { acts.push(a); } });
        acts.forEach(function (a) { a.label = label; removals.push(a); }); }
    };
  } },
  Guid: { fromString: function (s) { return s; } },
  Constants: { MediaType: { AUDIO: "audio", VIDEO: "video" }, TrackItemType: { CLIP: 1 } },
  SequenceEditor: { getEditor: function () { return {
    createRemoveItemsAction: function (sel, ripple, mediaType, alignToVideo) {
      return { names: sel.items.map(function (i) { return i.name; }).join(","), ripple: ripple, mediaType: mediaType };
    } }; } },
  TrackItemSelection: { createEmptySelection: function (cb) {
    var sel = { items: [], addItem: function (it) { sel.items.push(it); } }; cb(sel); } }
};
var module = { exports: {} };
(new Function("module", "exports", "require", readFile("js/ppro.js")))(
  module, module.exports, function (name) { if (name === "premierepro") return host; throw new Error("no " + name); });
var P = module.exports;

var gotVideo = null, gotAudio = null, gotDisabled = null, err = null;
P.removeClipsOnHiddenTracks("seq", "video").then(function (r) { gotVideo = r; }, function (e) { err = e; });
drainMicrotasks();
eq(err, null, "ran");
eq(gotVideo && gotVideo.map(function (r) { return r.track + ":" + r.name; }).join(" "), "V2:V2a V2:V2b",
   "every clip on the hidden track, and nothing on a shown one");
eq(removals.length, 1, "one removal, for the one hidden track");
eq(removals[0].names, "V2a,V2b", "both of its clips in it");
eq(removals[0].ripple, false, "never rippled - the gaps keep the conform in line");
eq(removals[0].mediaType, "video", "as video");

removals = [];
P.removeClipsOnHiddenTracks("seq", "audio").then(function (r) { gotAudio = r; }, function (e) { err = e; });
drainMicrotasks();
eq(gotAudio && gotAudio.map(function (r) { return r.track + ":" + r.name; }).join(" "), "A2:A2scratch",
   "a muted audio track's clips go from the mix");
eq(removals[0] && removals[0].mediaType, "audio", "as audio");

// The refactor must not change what "disabled" means.
removals = [];
P.removeDisabledClips("seq", "video").then(function (r) { gotDisabled = r; }, function (e) { err = e; });
drainMicrotasks();
eq(gotDisabled && gotDisabled.map(function (r) { return r.track + ":" + r.name; }).join(" "), "V3:V3off",
   "disabled clips are still found clip by clip, on shown tracks too");
eq(removals[0] && removals[0].label, "Remove disabled clips", "under their own undo label");

print((failed ? "FAILED " : "ok ") + passed + " passed, " + failed + " failed");
if (failed) throw new Error(failed + " failed");
