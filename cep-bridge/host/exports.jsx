/**
 * exports.jsx - the two exports Premiere 2025's UXP API cannot do.
 *
 * Premiere 25.x has no `ProjectConverter` in UXP, so The Onliner cannot write
 * an FCPXML or an AAF there. Its ExtendScript DOM can, and has for years:
 *
 *   sequence.exportAsFinalCutProXML(path, suppressUI)
 *   app.project.exportAAF(sequence, path, mixDownVideo, explodeToMono,
 *       sampleRate, bitsPerSample, embedAudio, audioFileFormat, trimSources,
 *       handleFrames, presetPath, renderAudioEffects, includeClipCopies,
 *       preserveParentFolder)
 *
 * Both verified on Premiere 25.6.6 against a real 13-clip grade timeline and a
 * 24-clip mix timeline (docs/API-FINDINGS.md §22). Flags go in as 1/0, never
 * true/false - that is how every argument here was proven to work, and the
 * 14-argument form is the only one tested.
 *
 * ExtendScript is ES3 with no JSON object, so arguments arrive as an object
 * literal the CEP side built with JSON.stringify (valid ES3), and results go
 * back through the tiny serializer below.
 */

function onlinerBridge_str(v) {
  var s = String(v), out = '"';
  for (var i = 0; i < s.length; i++) {
    var c = s.charAt(i), code = s.charCodeAt(i);
    if (c === '"' || c === "\\") out += "\\" + c;
    else if (code < 32) out += "\\u" + ("0000" + code.toString(16)).slice(-4);
    else out += c;
  }
  return out + '"';
}

/** Flat objects of strings, numbers, booleans and null only - all we return. */
function onlinerBridge_json(obj) {
  var parts = [];
  for (var k in obj) {
    if (!obj.hasOwnProperty(k)) continue;
    var v = obj[k], enc;
    if (v === null || v === undefined) enc = "null";
    else if (typeof v === "number") enc = isFinite(v) ? String(v) : "null";
    else if (typeof v === "boolean") enc = v ? "true" : "false";
    else enc = onlinerBridge_str(v);
    parts.push(onlinerBridge_str(k) + ":" + enc);
  }
  return "{" + parts.join(",") + "}";
}

/**
 * Find the sequence the panel means. By GUID first - UXP's sequence guid and
 * ExtendScript's sequenceID name the same thing - and by exact name only when
 * the GUID misses AND exactly one sequence carries that name, so an ambiguous
 * match can never export the wrong timeline.
 */
function onlinerBridge_findSequence(id, name) {
  var seqs = app.project.sequences, byName = [];
  for (var i = 0; i < seqs.numSequences; i++) {
    var s = seqs[i];
    if (id && String(s.sequenceID).toLowerCase() === String(id).toLowerCase()) {
      return { seq: s, matchedBy: "id" };
    }
    if (name && s.name === name) byName.push(s);
  }
  if (byName.length === 1) return { seq: byName[0], matchedBy: "name" };
  return { seq: null, matchedBy: null, nameMatches: byName.length };
}

function onlinerBridge_noSequence(found, a) {
  return onlinerBridge_json({
    ok: false,
    error: found.nameMatches > 1
      ? "More than one sequence is called “" + a.sequenceName + "” and its ID did not match, so the bridge will not guess which to export."
      : "The sequence to export is not in the open project (id " + a.sequenceId + ")."
  });
}

function onlinerBridge_exportFCPXML(a) {
  try {
    var found = onlinerBridge_findSequence(a.sequenceId, a.sequenceName);
    if (!found.seq) return onlinerBridge_noSequence(found, a);
    var exported = found.seq.exportAsFinalCutProXML(a.outputPath, 1);
    return onlinerBridge_json({ ok: true, exported: !!exported, matchedBy: found.matchedBy,
                                sequenceName: found.seq.name });
  } catch (e) {
    return onlinerBridge_json({ ok: false, error: "exportAsFinalCutProXML threw: " + e });
  }
}

function onlinerBridge_exportAAF(a) {
  try {
    var found = onlinerBridge_findSequence(a.sequenceId, a.sequenceName);
    if (!found.seq) return onlinerBridge_noSequence(found, a);
    var o = a.options || {};
    var n = function (v) { return v ? 1 : 0; };
    var result = app.project.exportAAF(
      found.seq, a.outputPath,
      n(o.mixdownVideo),
      n(o.explodeToMono),
      Number(o.sampleRate) || 48000,
      Number(o.bitsPerSample) || 24,
      n(o.embedAudio),
      o.audioFileFormat === 0 ? 0 : 1,          // 0 AIFF, 1 Broadcast Wave
      n(o.trimSources),
      Number(o.handleFrames) || 0,
      o.videoMixdownPresetPath || "",
      n(o.renderAudioEffects),
      n(o.interleaveWithoutEffects),
      n(o.preserveParentFolder));
    return onlinerBridge_json({ ok: true, exported: result !== false && result !== 0,
                                returned: String(result), matchedBy: found.matchedBy,
                                sequenceName: found.seq.name });
  } catch (e) {
    return onlinerBridge_json({ ok: false, error: "exportAAF threw: " + e });
  }
}

/** What this host can do, for the heartbeat. */
function onlinerBridge_capabilities() {
  var fcpxml = false, aaf = false;
  try { aaf = typeof app.project.exportAAF === "function"; } catch (e) {}
  try {
    var seqs = app.project.sequences;
    // A sequence object is needed to see the method; with none open, report
    // what Premiere has always had rather than a false negative.
    fcpxml = seqs.numSequences ? typeof seqs[0].exportAsFinalCutProXML === "function" : true;
  } catch (e) {}
  return onlinerBridge_json({ exportFCPXML: fcpxml, exportAAF: aaf, appVersion: String(app.version) });
}
