/**
 * ppro.js - the ONLY module that talks to the premierepro API.
 *
 * Everything above this line (app.js, the UI) deals in plain objects and never
 * imports `premierepro`. Same rule as the consolidator: when Adobe moves the
 * API - and it is moving, methods here are versioned "Since 26.2" - there is
 * one file to fix.
 *
 * Findings that shaped this module, all checked against the running app
 * (Premiere 26.3.2) rather than the docs, which are behind:
 *
 *  - `ProjectConverter.exportAAF` and the `AAFExportOptions` class DO exist at
 *    runtime, despite being absent from the bundled TypeScript definitions.
 *    See docs/API-FINDINGS.md.
 *  - Writes must go through `project.executeTransaction(cb, undoString)`, which
 *    collects actions into one compound action - so a panel run is ONE undo
 *    step for the editor, not fifty.
 *  - Reads that must not race a user edit go inside `project.lockedAccess`.
 */

let _ppro = null;

/** Lazily require the host module so this file can be loaded outside Premiere. */
function ppro() {
  if (!_ppro) _ppro = require("premierepro");
  return _ppro;
}

/** True when we are actually running inside Premiere. */
function isAvailable() {
  try {
    return !!ppro();
  } catch (e) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Project / sequence reads
// ---------------------------------------------------------------------------

async function getActiveProject() {
  const p = await ppro().Project.getActiveProject();
  if (!p) throw new Error("No project is open in Premiere.");
  return p;
}

/**
 * What the panel header shows. Returns null rather than throwing when no
 * project is open - an empty Premiere is a normal state, not an error.
 */
async function readProjectSummary() {
  let project;
  try {
    project = await getActiveProject();
  } catch (e) {
    return null;
  }
  const sequences = await project.getSequences();
  let active = null;
  try {
    const seq = await project.getActiveSequence();
    if (seq) active = { id: String(seq.guid), name: seq.name };
  } catch (e) {
    // No sequence open. Not an error.
  }
  return {
    projectId: String(project.guid),
    name: project.name,
    path: project.path,
    sequenceCount: sequences.length,
    activeSequence: active
  };
}

/**
 * Every sequence name in the project, for collision checks.
 *
 * Note this includes the backing sequences of multicam clips, which is what we
 * want - they occupy the same name space.
 */
async function listSequenceNames() {
  const project = await getActiveProject();
  const sequences = await project.getSequences();
  return sequences.map((s) => s.name);
}

async function listSequences() {
  const project = await getActiveProject();
  const sequences = await project.getSequences();
  return sequences.map((s) => ({ id: String(s.guid), name: s.name }));
}

/**
 * Track counts and clip totals for the source sequence, so the analysis run can
 * say what it is about to work on before anything is written.
 */
async function readSequenceShape(sequenceId) {
  const project = await getActiveProject();
  // The type defs declare `getSequence(guid): Sequence`, with no Promise. It
  // returns one anyway - unawaited you get a Promise whose every method is
  // missing, and the first call fails as "getVideoTrackCount is not a
  // function". Verified on 26.3.2.
  const seq = await project.getSequence(ppro().Guid.fromString(sequenceId));
  if (!seq) throw new Error("Sequence " + sequenceId + " is not in the active project.");

  const videoTrackCount = await seq.getVideoTrackCount();
  const audioTrackCount = await seq.getAudioTrackCount();
  let captionTrackCount = 0;
  try {
    captionTrackCount = await seq.getCaptionTrackCount();
  } catch (e) {
    // Older builds throw rather than returning 0.
  }

  const CLIP = ppro().Constants.TrackItemType.CLIP;
  let videoClips = 0;
  let audioClips = 0;
  const emptyVideoTracks = [];
  const emptyAudioTracks = [];

  for (let i = 0; i < videoTrackCount; i++) {
    const track = await seq.getVideoTrack(i);
    const items = await track.getTrackItems(CLIP, false);
    videoClips += items.length;
    if (items.length === 0) emptyVideoTracks.push(i + 1);
  }
  for (let i = 0; i < audioTrackCount; i++) {
    const track = await seq.getAudioTrack(i);
    const items = await track.getTrackItems(CLIP, false);
    audioClips += items.length;
    if (items.length === 0) emptyAudioTracks.push(i + 1);
  }

  return {
    id: String(seq.guid),
    name: seq.name,
    videoTrackCount,
    audioTrackCount,
    captionTrackCount,
    videoClips,
    audioClips,
    emptyVideoTracks,
    emptyAudioTracks
  };
}

// ---------------------------------------------------------------------------
// Bins
// ---------------------------------------------------------------------------

/**
 * Find existing bins by name, anywhere in the project tree.
 *
 * These projects already have FOR_GRADE / FOR_MIX bins, nested a couple of
 * levels down (MAIN_CUTS/ONLINE/FOR_GRADE in the project it was built on). Creating a
 * second bin of the same name at the root would scatter the handoffs across
 * two places, so the panel looks for one first and only creates when there is
 * genuinely none.
 *
 * Returns a map of name -> { path, found } for each name asked for. Where a
 * name matches more than once, the shallowest match wins, and `duplicates`
 * lists the rest so the panel can say so rather than picking silently.
 *
 * `getItems()` returns every child including clips, so this walks the whole
 * project. A node budget keeps a 1,700-item project from stalling the panel -
 * the same size of project that takes minutes to walk on the CEP side.
 */
async function findBins(names) {
  const P = ppro();
  const wanted = {};
  names.filter(Boolean).forEach((n) => { wanted[n.toLowerCase()] = n; });

  const result = {};
  Object.keys(wanted).forEach((k) => {
    result[wanted[k]] = { path: null, found: false, duplicates: [] };
  });

  const project = await getActiveProject();
  const root = await project.getRootItem();

  let budget = 20000;
  // Breadth-first, so the shallowest match is the one found first.
  let frontier = [{ folder: root, path: "" }];

  while (frontier.length && budget > 0) {
    const next = [];
    for (const node of frontier) {
      let items;
      try {
        items = await node.folder.getItems();
      } catch (e) {
        continue;
      }
      for (const item of items) {
        if (--budget <= 0) break;
        let folder = null;
        try {
          folder = P.FolderItem.cast(item);
        } catch (e) {
          folder = null;
        }
        if (!folder) continue;

        const name = item.name;
        const path = node.path + "/" + name;
        const hit = wanted[String(name).toLowerCase()];
        if (hit) {
          if (!result[hit].found) {
            result[hit].found = true;
            result[hit].path = path;
          } else {
            result[hit].duplicates.push(path);
          }
        }
        next.push({ folder: folder, path: path });
      }
    }
    frontier = next;
  }

  return { bins: result, exhausted: budget <= 0 };
}

// ---------------------------------------------------------------------------
// Capability probe
// ---------------------------------------------------------------------------

/**
 * What this build of Premiere can actually do, asked of the runtime rather
 * than assumed from a version number. The panel disables the options that
 * would silently do nothing.
 */
async function probeCapabilities() {
  const P = ppro();
  const converter = P.ProjectConverter || {};
  const caps = {
    hostVersion: null,
    exportFCPXML: typeof converter.exportAsFinalCutProXML === "function",
    exportAAF: typeof converter.exportAAF === "function",
    // "uxp" | "cep" | null - which route each export takes on this build.
    exportVia: { fcpxml: null, aaf: null },
    cepBridge: null,
    exportOTIO: typeof converter.exportAsOpenTimelineIO === "function",
    aafOptions: typeof P.AAFExportOptions === "function",
    encoder: false,
    ameInstalled: false,
    timecodeFilter: null
  };

  try {
    const uxp = require("uxp");
    caps.hostVersion = uxp.host && uxp.host.version ? String(uxp.host.version) : null;
  } catch (e) {
    // Not fatal - the version is for the report only.
  }

  try {
    const mgr = P.EncoderManager.getManager();
    caps.encoder = !!mgr;
    caps.ameInstalled = !!mgr.isAMEInstalled;
  } catch (e) {
    caps.encoder = false;
  }

  // The burn-in effect is looked up by display name, then cached as its match
  // name. Adobe renames display strings between versions far more readily than
  // match names, so we resolve once and hold the match name.
  try {
    const displays = await P.VideoFilterFactory.getDisplayNames();
    const matches = await P.VideoFilterFactory.getMatchNames();
    const idx = displays.findIndex((d) => /timecode/i.test(String(d)) && /burn/i.test(String(d)));
    if (idx >= 0) caps.timecodeFilter = { displayName: displays[idx], matchName: matches[idx] };
  } catch (e) {
    caps.timecodeFilter = null;
  }

  // Premiere 25.x has no ProjectConverter in UXP at all. Where a native export
  // is missing, the CEP bridge can do it through ExtendScript - if it is
  // installed and Premiere has started it (docs/API-FINDINGS.md §22).
  caps.exportVia.fcpxml = caps.exportFCPXML ? "uxp" : null;
  caps.exportVia.aaf = caps.exportAAF && caps.aafOptions ? "uxp" : null;
  if (!caps.exportVia.fcpxml || !caps.exportVia.aaf) {
    const bridge = await cepBridge().status();
    caps.cepBridge = bridge;
    const bc = bridge.running && bridge.caps ? bridge.caps : {};
    if (!caps.exportVia.fcpxml && bc.exportFCPXML) caps.exportVia.fcpxml = "cep";
    if (!caps.exportVia.aaf && bc.exportAAF) caps.exportVia.aaf = "cep";
  }
  caps.exportFCPXML = !!caps.exportVia.fcpxml;
  caps.exportAAF = !!caps.exportVia.aaf;

  return caps;
}

function cepBridge() {
  return requireSibling("cepbridge");
}

/** Which route an export takes right now - asked live, at the point of use. */
function nativeExport(kind) {
  const P = ppro();
  const converter = P.ProjectConverter || {};
  if (kind === "fcpxml") return typeof converter.exportAsFinalCutProXML === "function";
  return typeof converter.exportAAF === "function" && typeof P.AAFExportOptions === "function";
}

// ---------------------------------------------------------------------------
// Phase 2 - reference export
// ---------------------------------------------------------------------------

/**
 * Build the reference sequence as a NEST of the source.
 *
 * The spec called for an adjustment layer, but there is no API to create one -
 * `isAdjustmentLayer()` can only detect them. Nesting reaches the same end more
 * cleanly: `createSequenceFromMedia` with the source sequence's own project
 * item produces a new sequence whose V1 holds the whole programme as a single
 * track item, sized and timed to match (verified: a 1280x720 source produced a
 * 1280x720 reference, not the 1920x1080 default). One track item means one
 * component chain to burn into, and the source sequence is never opened, let
 * alone modified.
 */
async function createReferenceSequence(sourceSequenceId, name) {
  const P = ppro();
  const project = await getActiveProject();
  const src = await project.getSequence(P.Guid.fromString(sourceSequenceId));
  if (!src) throw new Error("Source sequence is not in the active project.");

  const projectItem = await src.getProjectItem();
  const clipItem = P.ClipProjectItem.cast(projectItem);
  if (!clipItem) throw new Error("Could not use \"" + src.name + "\" as media for a nest.");

  const ref = await project.createSequenceFromMedia(name, [clipItem]);
  if (!ref) throw new Error("Premiere did not create the reference sequence.");
  return { id: String(ref.guid), name: ref.name };
}

/**
 * Apply "Metadata & Timecode Burn-in" to the reference sequence's single
 * nested track item, and switch its first line on.
 *
 * Two hard-won rules are baked in here:
 *
 *  1. **Component actions must be created and executed inside
 *     `project.lockedAccess()`, with no `await` between acquiring a handle and
 *     using it.** Outside it, `chain.createAppendComponentAction()` throws "The
 *     script object is no longer valid" every time - on nests, on ordinary
 *     clips, and with any filter, so it is not about this effect. Acquire
 *     everything first, then do the whole write synchronously.
 *  2. **The effect renders nothing as applied.** All five of its text lines
 *     default to off, so an unattended "apply" produces a clean-looking export
 *     with no timecode on it at all. Line 1 must be switched on.
 *
 * The component handle returned by `createComponent` is opaque - it has no
 * methods of its own and exists only to be handed to the chain action.
 */
async function applyTimecodeBurnIn(sequenceId, matchName, options) {
  const P = ppro();
  const opts = options || {};
  const project = await getActiveProject();
  const seq = await project.getSequence(P.Guid.fromString(sequenceId));
  const track = await seq.getVideoTrack(0);
  const items = await track.getTrackItems(P.Constants.TrackItemType.CLIP, false);
  if (!items.length) throw new Error("The reference sequence has no clip to burn into.");

  // The burn-in's text is a fixed pixel size while its Position is a fraction
  // of the frame, so Adobe's default x of 0.38 runs the timecode off the right
  // edge of a 1080-wide 9x16 (docs/API-FINDINGS.md §23). Lay it out for the
  // actual frame. A build without getFrameSize keeps Adobe's position.
  let frameWidth = null;
  try {
    const rect = await seq.getFrameSize();
    if (rect && rect.width > 0) frameWidth = rect.width;
  } catch (e) { frameWidth = null; }
  const layout = requireSibling("burnin").burnInLayout(frameWidth, opts.size == null ? 25 : opts.size);

  const chain = await items[0].getComponentChain();
  const component = await P.VideoFilterFactory.createComponent(matchName);
  if (!component) throw new Error("Could not create the burn-in effect (" + matchName + ").");

  // createAppendComponentAction MUST be called inside lockedAccess, not just
  // the transaction. Called outside it throws "The script object is no longer
  // valid" - which is what made the burn-in path fail while the plain export
  // worked, since the plain path never touches a component chain.
  project.lockedAccess(() => {
    const appendAction = chain.createAppendComponentAction(component);
    project.executeTransaction((c) => { c.addAction(appendAction); }, "Add timecode burn-in");
  });

  // Re-read to find the component that actually landed - the handle above
  // cannot be inspected.
  let burn = null;
  const count = await chain.getComponentCount();
  for (let i = count - 1; i >= 0; i--) {
    const c = await chain.getComponentAtIndex(i);
    if ((await c.getMatchName()) === matchName) { burn = c; break; }
  }
  if (!burn) throw new Error("The burn-in effect did not attach to the reference sequence.");

  // Address params by display name. The chain contains params with duplicate
  // and even blank display names, so index arithmetic is not safe; "Line 1" is
  // the enable for the first text line and the "Size"/"Opacity" before any
  // line marker are the effect-wide ones.
  const paramCount = burn.getParamCount();
  const params = [];
  for (let p = 0; p < paramCount; p++) {
    let displayName = "";
    try { displayName = burn.getParam(p).displayName; } catch (e) { displayName = ""; }
    params.push({ index: p, displayName });
  }
  const indexOf = (name) => {
    const hit = params.find((x) => x.displayName === name);
    return hit ? hit.index : -1;
  };

  const lineIndex = indexOf("Line 1");
  if (lineIndex < 0) throw new Error("Could not find the burn-in's \"Line 1\" switch.");
  const sizeIndex = params.length ? params[0].index : -1;      // effect-wide Size
  const opacityIndex = params.length > 1 ? params[1].index : -1; // effect-wide Opacity

  // Line 1's own Position is the first "Position" after the "Line 1" switch
  // and before "Line 2" - every line block has one, so never the first overall.
  const nextLine = params.find((x) => x.index > lineIndex && /^Line \d/.test(x.displayName));
  const posHit = params.find((x) => x.index > lineIndex && x.displayName === "Position" &&
                                    (!nextLine || x.index < nextLine.index));

  const lineParam = burn.getParam(lineIndex);
  const sizeParam = sizeIndex >= 0 ? burn.getParam(sizeIndex) : null;
  const opacityParam = opacityIndex >= 0 ? burn.getParam(opacityIndex) : null;
  const positionParam = posHit && layout.x != null ? burn.getParam(posHit.index) : null;
  const size = layout.size;
  const opacity = opts.opacity == null ? 100 : opts.opacity;

  project.lockedAccess(() => {
    const actions = [lineParam.createSetValueAction(lineParam.createKeyframe(true), true)];
    // Defaults are 15/40 - small and half-faded for something a colourist and a
    // client are meant to read off a viewing copy.
    if (sizeParam) actions.push(sizeParam.createSetValueAction(sizeParam.createKeyframe(size), true));
    if (opacityParam) actions.push(opacityParam.createSetValueAction(opacityParam.createKeyframe(opacity), true));
    // A point param writes as a PointF, built HERE inside lockedAccess - one
    // built outside dies as "script object is no longer valid".
    if (positionParam) {
      actions.push(positionParam.createSetValueAction(
        positionParam.createKeyframe(new P.PointF(layout.x, layout.y)), true));
    }
    project.executeTransaction((c) => { actions.forEach((a) => c.addAction(a)); }, "Configure timecode burn-in");
  });

  // Deliberately NOT asserting on a read-back of the "Line 1" switch: boolean
  // params report their default no matter what was written (the numeric ones
  // read back correctly). Proof that this works is a rendered frame - see
  // exportStillFrame, which is how the phase was signed off.
  return { componentIndex: count - 1, paramCount, lineIndex, frameWidth,
           size, positioned: !!positionParam, x: positionParam ? layout.x : null, shrunk: layout.shrunk };
}

/**
 * Export a sequence: queue it to Media Encoder, or render it here and now.
 *
 * "now" (`EXPORT_IMMEDIATELY`) is the only route that actually starts on its
 * own. There is an undocumented `EncoderManager.startBatchEncode()`, but it
 * does NOT start Media Encoder's queue - it returns `true` even with an empty
 * queue, so its return value proves nothing, and a job queued to AME sat
 * unrendered with AME idle at 1% CPU after calling it. `EXPORT_QUEUE_TO_APP`,
 * which its name suggests it drives, refuses the job outright and returns
 * false.
 *
 * So: queueing needs someone to press Start in AME; rendering immediately does
 * not, at the cost of tying Premiere up while it works. Verified - an immediate
 * export produced a complete 63.2s H.264 with nobody touching anything.
 *
 * `launchEncoder()` is called for the queue route so AME is at least up and
 * showing the job rather than silently holding it.
 */
async function queueExport(sequenceId, outputFile, presetFile, mode) {
  const P = ppro();
  const project = await getActiveProject();
  const seq = await project.getSequence(P.Guid.fromString(sequenceId));
  if (!seq) throw new Error("Sequence to export is not in the active project.");

  const manager = P.EncoderManager.getManager();
  if (!manager) throw new Error("Premiere's encoder manager is unavailable.");

  const types = {
    ame: P.EncoderManager.EXPORT_QUEUE_TO_AME,
    app: P.EncoderManager.EXPORT_QUEUE_TO_APP,
    now: P.EncoderManager.EXPORT_IMMEDIATELY
  };
  const chosen = mode || "ame";
  const exportType = types[chosen];
  if (exportType === undefined) throw new Error("Unknown export mode: " + chosen);
  if (chosen === "ame" && !manager.isAMEInstalled) {
    throw new Error("Media Encoder is not installed, so the export cannot be queued to it.");
  }
  if (chosen === "ame") {
    // Bring AME up so the job is visible rather than silently held.
    try { await manager.launchEncoder(); } catch (e) { /* not fatal */ }
  }

  // The native binding is fussy about argument shapes in ways that differ by
  // build: Premiere 26.5.2 on Windows threw "Illegal Parameter type" at the
  // five-argument call that 26.3.2 on a Mac accepts. Try the shapes in order
  // and keep the first that works; if none does, report every refusal so the
  // next person sees what was tried instead of one opaque message.
  const attempts = [
    ["5 args", () => manager.exportSequence(seq, exportType, outputFile, presetFile || undefined, true)],
    ["4 args", () => manager.exportSequence(seq, exportType, outputFile, presetFile || undefined)],
    ["3 args", () => manager.exportSequence(seq, exportType, outputFile)],
    ["4 args, empty preset", () => manager.exportSequence(seq, exportType, outputFile, presetFile || "")],
    ["5 args, exportFull false", () => manager.exportSequence(seq, exportType, outputFile, presetFile || undefined, false)]
  ];
  let ok;
  const refusals = [];
  for (const pair of attempts) {
    try {
      ok = await pair[1]();
      refusals.length = 0;
      break;
    } catch (e) {
      refusals.push(pair[0] + ": " + (e.message || e));
    }
  }
  if (refusals.length) {
    // Measured on 26.5.2 (Windows), rendering now with no preset: `undefined`
    // for presetFile is "Illegal Parameter type", leaving it out is "Invalid
    // parameter." - the immediate export has no format to render to. The
    // sequence's own export settings are not a thing the API can ask for, so
    // say what the editor can actually do.
    if (!presetFile) {
      throw new Error("Premiere needs an export preset for the reference export on this " +
                      "machine - choose one in the Reference section and run again. (" +
                      refusals[0] + ")");
    }
    throw new Error("Premiere refused the export (type " + String(exportType) + "). Tried " +
                    refusals.join(" | "));
  }
  return { started: ok, mode: chosen, output: outputFile };
}

/**
 * Render one frame to disk. This is the panel's own proof that a burn-in
 * actually shows - a rendered frame is the only trustworthy check, given the
 * effect's switches cannot be read back.
 *
 * The filename MUST carry an extension or Premiere fails with the unhelpful
 * "Internal error : File Format is not supported".
 */
async function exportStillFrame(sequenceId, seconds, fileName, folderPath, width, height) {
  const P = ppro();
  const project = await getActiveProject();
  const seq = await project.getSequence(P.Guid.fromString(sequenceId));
  if (!/\.(png|jpg|jpeg|tif|tiff|tga|bmp|dpx|exr|gif)$/i.test(fileName)) {
    throw new Error("Still frame filename needs an image extension: " + fileName);
  }
  const time = P.TickTime.createWithSeconds(seconds);
  return await P.Exporter.exportSequenceFrame(seq, time, fileName, folderPath, width, height);
}

/** Remove a sequence - used to roll back a half-built run. */
async function deleteSequenceById(sequenceId) {
  const P = ppro();
  const project = await getActiveProject();
  const seq = await project.getSequence(P.Guid.fromString(sequenceId));
  if (!seq) return false;
  return await project.deleteSequence(seq);
}


// ---------------------------------------------------------------------------
// Phase 3 - grade timeline
// ---------------------------------------------------------------------------

/**
 * Re-fetch a Sequence by GUID, every time.
 *
 * A Sequence object does not survive being carried across a pipeline. Held from
 * the clone through strip / remove / flatten and then handed to the clip walk,
 * it goes stale and everything after it fails with "The script object is no
 * longer valid" - which is why a run could flatten 12 clips successfully and
 * then die on the very next call.
 *
 * So the grade pipeline passes a GUID string between stages, never a Sequence,
 * and every function re-resolves at entry. Accepts an object with a `guid` too,
 * so a caller holding one is corrected rather than punished.
 */
async function resolveSequence(ref) {
  const P = ppro();
  const project = await getActiveProject();
  const id = (ref && ref.guid !== undefined) ? String(ref.guid) : String(ref);
  const seq = await project.getSequence(P.Guid.fromString(id));
  if (!seq) throw new Error("Sequence " + id + " is no longer in the project.");
  return seq;
}

/**
 * Effects that survive "remove other applied effects".
 *
 * Motion and Opacity are fixed effects - they cannot be removed at all, only
 * reset, so attempting it throws.
 *
 * Warp Stabilizer is a deliberate judgement call, not an oversight. It is not a
 * look, it is geometry the cut depends on, so it is kept rather than stripped.
 *
 * IMPORTANT, and it undercuts half the reason: **Warp Stabilizer does not
 * survive FCP7 XML export.** Premiere's own translation report says
 * "Effect <Warp Stabilizer> on Clip <...> not translated". So the colourist
 * receives those shots unstabilised whatever we do here - keeping it preserves
 * the intent in the Premiere sequence, not in the XML. The panel says so in the
 * report rather than implying the conform will match.
 */
var KEEP_EFFECTS = {
  "AE.ADBE Motion": "fixed effect, cannot be removed",
  "AE.ADBE Opacity": "fixed effect, cannot be removed",
  "AE.ADBE SubspaceStabilizer": "stabilisation - removing it would break the conform"
};

/** Motion's defaults, read off an untouched clip rather than assumed. */
/** Colour labels, from Constants.ProjectItemColorLabel on this build. */
var COLOUR = { GRADE: 0 /* VIOLET */, MIX: 4 /* CERULEAN */ };

/**
 * Motion's defaults, read off an untouched clip rather than assumed.
 *
 * Point parameters are declared as descriptors, not literal pairs, because
 * reads and writes are NOT symmetrical: `getValueAtTime` hands back a plain
 * Array for Position and Anchor Point, but `createKeyframe` rejects an Array
 * with "Illegal Parameter type" and requires a real `PointF`. Feeding back the
 * exact value just read fails. Scalars round-trip fine, which is what makes
 * the asymmetry easy to miss - and one bad param aborts the WHOLE transaction,
 * so a single failing Position write silently loses the Scale and Rotation
 * resets alongside it. That is how all 49 clips came back unreset.
 */
var MOTION_DEFAULTS = {
  "Position": { type: "point", x: 0.5, y: 0.5 },
  "Scale": { type: "scalar", value: 100 },
  "Scale Width": { type: "scalar", value: 100 },
  "Rotation": { type: "scalar", value: 0 },
  "Anchor Point": { type: "point", x: 0.5, y: 0.5 },
  "Crop Left": { type: "scalar", value: 0 },
  "Crop Top": { type: "scalar", value: 0 },
  "Crop Right": { type: "scalar", value: 0 },
  "Crop Bottom": { type: "scalar", value: 0 }
};

/** Turn a default descriptor into something createKeyframe will accept. */
function motionDefaultValue(spec) {
  const P = ppro();
  return spec.type === "point" ? new P.PointF(spec.x, spec.y) : spec.value;
}

/** Duplicate a sequence and hand back the copy. */
async function cloneSequence(sourceSequenceId) {
  const P = ppro();
  const project = await getActiveProject();
  const src = await resolveSequence(sourceSequenceId);
  if (!src) throw new Error("Source sequence is not in the active project.");

  const before = {};
  (await project.getSequences()).forEach((s) => { before[String(s.guid)] = true; });

  project.lockedAccess(() => {
    const action = src.createCloneAction();
    project.executeTransaction((c) => { c.addAction(action); }, "Duplicate sequence");
  });

  // createCloneAction does not hand back the clone, and Premiere names it
  // itself ("<name> Copy"), so identify it by difference rather than by name.
  const after = await project.getSequences();
  const fresh = after.filter((s) => !before[String(s.guid)]);
  if (fresh.length !== 1) {
    throw new Error("Expected exactly one new sequence from the duplicate, got " + fresh.length + ".");
  }
  // A GUID, not the Sequence: the object would be stale by the next stage.
  return { id: String(fresh[0].guid), name: fresh[0].name };
}

/** Rename a sequence via its project item. */
async function renameSequence(sequenceRef, newName) {
  const project = await getActiveProject();
  const sequence = await resolveSequence(sequenceRef);
  const item = await sequence.getProjectItem();
  project.lockedAccess(() => {
    const action = item.createSetNameAction(newName);
    project.executeTransaction((c) => { c.addAction(action); }, "Rename sequence");
  });
}

/**
 * Remove every clip from the audio tracks.
 *
 * Note this leaves the audio TRACKS in place, empty. There is no track
 * add/delete anywhere in the UXP API - tracks can be counted, read, renamed and
 * muted, never created or removed - so "strip to video-only" can only mean
 * emptying them. For the FCPXML handoff the empty <track> elements are stripped
 * from the exported file instead, which gives the colourist the clean timeline
 * they expect.
 */
async function stripAudioClips(sequenceRef) {
  const P = ppro();
  const project = await getActiveProject();
  const sequence = await resolveSequence(sequenceRef);
  const count = await sequence.getAudioTrackCount();
  let removed = 0;

  for (let i = 0; i < count; i++) {
    const track = await sequence.getAudioTrack(i);
    const items = await track.getTrackItems(P.Constants.TrackItemType.CLIP, false);
    if (!items.length) continue;

    // The editor and the selection are BOTH acquired inside lockedAccess, at the
    // point of use. Fetching the editor once before the loop and using it after
    // a few awaits fails with "The script object is no longer valid" and removes
    // nothing - the rule is not just about where the action is created, it is
    // about every handle the action is built from being fresh.
    //
    // A fresh selection also matters for a second reason: sequence.getSelection()
    // returns whatever the editor has selected in the timeline right now, so
    // removing against it would delete their selection instead of the audio.
    project.lockedAccess(() => {
      const editor = P.SequenceEditor.getEditor(sequence);
      let selection = null;
      P.TrackItemSelection.createEmptySelection((sel) => { selection = sel; });
      if (!selection) throw new Error("Could not build a selection to strip audio with.");
      items.forEach((it) => { try { selection.addItem(it, true); } catch (e) { /* already present */ } });
      const action = editor.createRemoveItemsAction(selection, false, P.Constants.MediaType.AUDIO, false);
      project.executeTransaction((c) => { c.addAction(action); }, "Strip audio");
    });
    removed += items.length;
  }
  return removed;
}

/**
 * Remove every disabled clip from the video tracks.
 *
 * Disabled clips are invisible in the programme but very much present in the
 * timeline, and they export into the FCPXML like any other - so a colourist
 * conforming the handoff gets shots the edit had deliberately switched off.
 *
 * Ripple is FALSE, and must stay false: rippling would close the gaps and shift
 * every clip after each removal, so the conform would no longer line up with
 * picture. The gap a disabled clip leaves behind is correct - nothing was
 * showing there anyway.
 */
async function removeDisabledClips(sequenceRef, kind) {
  return removeClipsWhere(sequenceRef, kind, "Remove disabled clips", async (track, item) => {
    try { return await item.isDisabled(); } catch (e) { return false; }
  });
}

/**
 * Remove every clip on a track the editor has switched off - a hidden video
 * track (the eye) or a muted audio track.
 *
 * The same reasoning as disabled clips, one level up: nothing on such a track
 * reaches the programme, but every clip on it still exports. Measured on a
 * 9:16 test cut, a clip on hidden V2 was flattened onto V1 of the grade
 * timeline and would have been graded. The track itself stays (Premiere cannot
 * delete tracks); it is left empty, and "Strip empty tracks" takes it out of
 * the XML. No ripple, for the same reason as above.
 */
async function removeClipsOnHiddenTracks(sequenceRef, kind) {
  return removeClipsWhere(sequenceRef, kind, "Remove clips on hidden tracks", async (track) => {
    try { return !!(await track.isMuted()); } catch (e) { return false; }
  });
}

/** Remove the clips `pick` chooses, track by track, leaving gaps in place. */
async function removeClipsWhere(sequenceRef, kind, label, pick) {
  const P = ppro();
  const project = await getActiveProject();
  const sequence = await resolveSequence(sequenceRef);
  const audio = kind === "audio";
  const mediaType = audio ? P.Constants.MediaType.AUDIO : P.Constants.MediaType.VIDEO;
  const prefix = audio ? "A" : "V";
  const trackCount = audio
    ? await sequence.getAudioTrackCount()
    : await sequence.getVideoTrackCount();
  const removed = [];

  for (let t = 0; t < trackCount; t++) {
    const track = audio ? await sequence.getAudioTrack(t) : await sequence.getVideoTrack(t);
    const items = await track.getTrackItems(P.Constants.TrackItemType.CLIP, false);
    // Record POSITIONS, not handles: reading a 21-clip track is 42 awaits, and
    // handles gathered before all of them can be stale by the time they are
    // used. See removeHiddenClips for where this actually bit.
    const chosen = [];
    for (let i = 0; i < items.length; i++) {
      if (await pick(track, items[i])) chosen.push({ index: i, name: await items[i].getName() });
    }
    if (!chosen.length) continue;

    // Re-fetch, so every handle used below is fresh. Editor and selection are
    // acquired inside lockedAccess for the same reason - see stripAudioClips
    // for why a stale editor silently removes nothing.
    const fresh = await track.getTrackItems(P.Constants.TrackItemType.CLIP, false);
    project.lockedAccess(() => {
      const editor = P.SequenceEditor.getEditor(sequence);
      let selection = null;
      P.TrackItemSelection.createEmptySelection((sel) => { selection = sel; });
      if (!selection) throw new Error("Could not build a selection to " + label.toLowerCase() + " with.");
      chosen.forEach((d) => {
        const item = fresh[d.index];
        if (!item) return;
        try { selection.addItem(item, true); } catch (e) { /* already present */ }
      });
      const action = editor.createRemoveItemsAction(selection, false, mediaType, false);
      project.executeTransaction((c) => { c.addAction(action); }, label);
    });
    chosen.forEach((d) => removed.push({ track: prefix + (t + 1), name: d.name }));
  }
  return removed;
}


/**
 * Remove adjustment layers.
 *
 * An adjustment layer in an offline is almost always carrying the temp grade -
 * the teaser it was built on has two, spanning the whole film between them - and it is
 * the last thing a colourist wants arriving on top of their timeline. They are
 * clips, not effects, so "remove other applied effects" never touched them.
 */
async function removeAdjustmentLayers(sequenceRef) {
  const P = ppro();
  const project = await getActiveProject();
  const sequence = await resolveSequence(sequenceRef);
  const trackCount = await sequence.getVideoTrackCount();
  const removed = [];

  for (let t = 0; t < trackCount; t++) {
    const items = await (await sequence.getVideoTrack(t)).getTrackItems(P.Constants.TrackItemType.CLIP, false);
    // Positions, not handles - see removeDisabledClips.
    const layers = [];
    for (let i = 0; i < items.length; i++) {
      let isAdj = false;
      try { isAdj = await items[i].isAdjustmentLayer(); } catch (e) { isAdj = false; }
      if (isAdj) layers.push({ index: i, name: await items[i].getName() });
    }
    if (!layers.length) continue;

    const fresh = await (await sequence.getVideoTrack(t)).getTrackItems(P.Constants.TrackItemType.CLIP, false);
    project.lockedAccess(() => {
      const editor = P.SequenceEditor.getEditor(sequence);
      let selection = null;
      P.TrackItemSelection.createEmptySelection((sel) => { selection = sel; });
      layers.forEach((l) => {
        const item = fresh[l.index];
        if (!item) return;
        try { selection.addItem(item, true); } catch (e) { /* already present */ }
      });
      const action = editor.createRemoveItemsAction(selection, false, P.Constants.MediaType.VIDEO, false);
      project.executeTransaction((c) => { c.addAction(action); }, "Remove adjustment layers");
    });
    layers.forEach((l) => removed.push({ track: "V" + (t + 1), name: l.name }));
  }
  return removed;
}

/** Merge [start,end) intervals and report whether they cover a span entirely. */
function mergeIntervals(list) {
  const sorted = list.slice().sort((a, b) => a.start - b.start);
  const out = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv.start <= last.end) last.end = Math.max(last.end, iv.end);
    else out.push({ start: iv.start, end: iv.end });
  }
  return out;
}

function coverage(span, intervals) {
  let cursor = span.start;
  for (const iv of intervals) {
    if (iv.end <= cursor) continue;
    if (iv.start > cursor) break;      // a hole
    cursor = Math.max(cursor, iv.end);
    if (cursor >= span.end) return "full";
  }
  if (cursor <= span.start) {
    // Nothing covered the start; is anything covering it at all?
    const touches = intervals.some((iv) => iv.start < span.end && iv.end > span.start);
    return touches ? "partial" : "none";
  }
  return "partial";
}

/**
 * Remove clips that nothing can see, because a clip on a higher track covers
 * them for their whole length.
 *
 * Hidden clips are invisible in the programme and fully present in the FCPXML,
 * so a colourist conforms shots the edit had layered over. In the test teaser
 * three clips sit stacked at 00:00, and only the top one is on screen.
 *
 * TWO deliberate limits, because deleting something still visible is the worst
 * outcome this tool could produce:
 *
 *  - **Adjustment layers never count as covering.** They are pass-through; a
 *    LUT layer spanning the film would otherwise mark every clip beneath it
 *    hidden and empty the timeline.
 *  - **Only FULL coverage is removed.** A partly-covered clip is left alone and
 *    reported, because trimming it to the visible part would change the edit.
 *
 * What it cannot know is alpha: a logo or matte with transparency covers the
 * time range without hiding the picture, and this would treat the clip beneath
 * as hidden. That is why it is an option, and why every removal is listed by
 * name along with the clip that covered it.
 */
async function removeHiddenClips(sequenceRef) {
  const P = ppro();
  const project = await getActiveProject();
  const sequence = await resolveSequence(sequenceRef);
  const CLIP = P.Constants.TrackItemType.CLIP;
  const trackCount = await sequence.getVideoTrackCount();

  // Read the whole stack first - coverage cannot be judged one track at a time.
  // Coverage is computed from this original state, which is sound: anything
  // above that gets deleted was itself covered by something higher still, so it
  // cannot expose what it was hiding.
  //
  // Deliberately NOT keeping the track item handles from this pass. Reading ten
  // tracks is dozens of awaits, and by the time the first track's clips were
  // removed those handles were stale - "The script object is no longer valid",
  // intermittently, depending only on how long the read took. Every other
  // remover here reads and removes one track at a time, so it never noticed.
  // Positions are recorded instead, and the items re-fetched at the point of
  // removal.
  const tracks = [];
  for (let t = 0; t < trackCount; t++) {
    const items = await (await sequence.getVideoTrack(t)).getTrackItems(CLIP, false);
    const rows = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const start = await item.getStartTime();
      const end = await item.getEndTime();
      let isAdj = false;
      try { isAdj = await item.isAdjustmentLayer(); } catch (e) { isAdj = false; }
      rows.push({
        index: i, name: await item.getName(), isAdj,
        start: Number(start.ticks), end: Number(end.ticks)
      });
    }
    tracks.push(rows);
  }

  const removed = [];
  const partial = [];

  for (let t = 0; t < trackCount; t++) {
    const doomed = [];
    for (const clip of tracks[t]) {
      if (clip.isAdj) continue;               // handled by removeAdjustmentLayers
      const above = [];
      for (let u = t + 1; u < trackCount; u++) {
        tracks[u].forEach((c) => { if (!c.isAdj) above.push({ start: c.start, end: c.end, name: c.name }); });
      }
      if (!above.length) continue;
      const merged = mergeIntervals(above);
      const verdict = coverage(clip, merged);
      if (verdict === "full") {
        const by = above.filter((a) => a.start < clip.end && a.end > clip.start).map((a) => a.name);
        doomed.push(clip.index);
        removed.push({ track: "V" + (t + 1), name: clip.name, coveredBy: by.slice(0, 3) });
      } else if (verdict === "partial") {
        partial.push({ track: "V" + (t + 1), name: clip.name });
      }
    }
    if (!doomed.length) continue;

    // Re-fetch this track's items now, so the handles are fresh. Nothing has
    // been removed from THIS track yet, so the positions still line up.
    const fresh = await (await sequence.getVideoTrack(t)).getTrackItems(CLIP, false);
    project.lockedAccess(() => {
      const editor = P.SequenceEditor.getEditor(sequence);
      let selection = null;
      P.TrackItemSelection.createEmptySelection((sel) => { selection = sel; });
      doomed.forEach((idx) => {
        const item = fresh[idx];
        if (!item) return;
        try { selection.addItem(item, true); } catch (e) { /* already present */ }
      });
      const action = editor.createRemoveItemsAction(selection, false, P.Constants.MediaType.VIDEO, false);
      project.executeTransaction((c) => { c.addAction(action); }, "Remove hidden clips");
    });
  }
  return { removed, partial };
}

/**
 * Reset Motion to its defaults on one clip, and remove the non-keeper effects.
 *
 * Keyframed parameters are set non-time-varying first; otherwise the value
 * write lands on a keyframe and the reframe animates back in.
 */
async function cleanClip(sequence, trackItem, opts) {
  const P = ppro();
  const project = await getActiveProject();
  const chain = await trackItem.getComponentChain();
  const result = { reset: [], removed: [], kept: [] };

  const count = await chain.getComponentCount();
  const components = [];
  for (let i = 0; i < count; i++) {
    const c = await chain.getComponentAtIndex(i);
    components.push({ component: c, matchName: await c.getMatchName() });
  }

  // --- reset Motion ---
  if (opts.resetMotion) {
    const motion = components.find((c) => c.matchName === "AE.ADBE Motion");
    if (motion) {
      const targets = [];
      for (let p = 0; p < motion.component.getParamCount(); p++) {
        const param = motion.component.getParam(p);
        const name = param.displayName;
        // Index 3 has a BLANK display name - it is Uniform Scale, and resetting
        // it would unlink width from height. Never touch an unnamed param.
        if (!name || !Object.prototype.hasOwnProperty.call(MOTION_DEFAULTS, name)) continue;
        let varying = false;
        try { varying = param.isTimeVarying(); } catch (e) { varying = false; }
        // Carry the SPEC, not a built value. A PointF constructed out here goes
        // stale before the transaction uses it, and the write dies as "The
        // script object is no longer valid" - the same rule as handles and
        // actions, in a third disguise. It is built inside lockedAccess below.
        targets.push({ param, name, varying, spec: MOTION_DEFAULTS[name] });
      }
      if (targets.length) {
        project.lockedAccess(() => {
          const actions = [];
          targets.forEach((t) => {
            if (t.varying) actions.push(t.param.createSetTimeVaryingAction(false));
            const value = motionDefaultValue(t.spec);
            actions.push(t.param.createSetValueAction(t.param.createKeyframe(value), true));
          });
          project.executeTransaction((c) => { actions.forEach((a) => c.addAction(a)); }, "Reset Motion");
        });
        result.reset = targets.map((t) => t.name);
      }
    }
  }

  // --- remove other effects ---
  if (opts.removeEffects) {
    const doomed = components.filter((c) => !Object.prototype.hasOwnProperty.call(KEEP_EFFECTS, c.matchName));
    const keepers = components.filter((c) => c.matchName === "AE.ADBE SubspaceStabilizer");
    if (doomed.length) {
      project.lockedAccess(() => {
        const actions = doomed.map((d) => chain.createRemoveComponentAction(d.component));
        project.executeTransaction((c) => { actions.forEach((a) => c.addAction(a)); }, "Remove effects");
      });
      result.removed = doomed.map((d) => d.matchName);
    }
    result.kept = keepers.map((k) => k.matchName);
  }

  return result;
}

/**
 * Walk the video clips: clean them, and flag anything retimed.
 *
 * Time Remapping cannot be read off the component chain - the spec is right
 * about that - but `TrackItem.getSpeed()` exposes the clip's speed directly,
 * which catches every constant speed change. A variable ramp that returns to
 * 100% overall would still slip through, so the wording in the report says
 * "speed changes found", not "all speed changes found".
 */
async function processGradeClips(sequenceRef, opts) {
  const P = ppro();
  const sequence = await resolveSequence(sequenceRef);
  const trackCount = await sequence.getVideoTrackCount();
  const summary = { clips: 0, motionReset: 0, effectsRemoved: 0, retimed: [], stabilised: [], multicam: [] };

  for (let t = 0; t < trackCount; t++) {
    const track = await sequence.getVideoTrack(t);
    const items = await track.getTrackItems(P.Constants.TrackItemType.CLIP, false);
    for (const item of items) {
      summary.clips++;
      const name = await item.getName();

      let speed = 1;
      try { speed = await item.getSpeed(); } catch (e) { speed = 1; }
      if (typeof speed === "number" && Math.abs(speed - 1) > 0.001) {
        let reversed = false;
        try { reversed = await item.isSpeedReversed(); } catch (e) { reversed = false; }
        summary.retimed.push({ track: "V" + (t + 1), name, speed: Math.round(speed * 1000) / 1000, reversed });
      }

      // Multicam clips do not survive FCP7 XML export - they vanish from the
      // file with no error - and they cannot be flattened from here: the active
      // angle is not exposed anywhere in the API (TrackItem has no angle or
      // camera method, and the multicam's backing sequence comes back null), so
      // guessing one would put the WRONG camera in the film. Name them instead,
      // and let the editor flatten in Premiere before running the grade prep.
      try {
        const projectItem = await item.getProjectItem();
        const clip = projectItem ? P.ClipProjectItem.cast(projectItem) : null;
        if (clip && (await clip.isMulticamClip())) {
          summary.multicam.push({ track: "V" + (t + 1), name });
        }
      } catch (e) {
        // Not fatal - the XML clipitem count still catches a short export.
      }

      const res = await cleanClip(sequence, item, opts);
      if (res.reset.length) summary.motionReset++;
      summary.effectsRemoved += res.removed.length;
      if (res.kept.length) summary.stabilised.push({ track: "V" + (t + 1), name });
    }
  }
  return summary;
}

/**
 * Re-scan a sequence for multicam clips.
 *
 * Used after the editor has gone away and flattened by hand, to confirm the
 * timeline is genuinely clear before the XML is written - rather than trusting
 * that they did it, or that they finished.
 */
async function scanMulticam(sequenceId) {
  const P = ppro();
  const project = await getActiveProject();
  const seq = await project.getSequence(P.Guid.fromString(sequenceId));
  if (!seq) throw new Error("That sequence is no longer in the project.");
  const found = [];
  const trackCount = await seq.getVideoTrackCount();
  for (let t = 0; t < trackCount; t++) {
    const items = await (await seq.getVideoTrack(t)).getTrackItems(P.Constants.TrackItemType.CLIP, false);
    for (const item of items) {
      try {
        const projectItem = await item.getProjectItem();
        const clip = projectItem ? P.ClipProjectItem.cast(projectItem) : null;
        if (clip && (await clip.isMulticamClip())) {
          found.push({ track: "V" + (t + 1), name: await item.getName() });
        }
      } catch (e) { /* a clip we cannot read is not evidence of multicam */ }
    }
  }
  return found;
}

/** Count the video clips on a sequence, for the XML verification. */
async function countVideoClips(sequenceId) {
  const P = ppro();
  const project = await getActiveProject();
  const seq = await project.getSequence(P.Guid.fromString(sequenceId));
  let n = 0;
  const trackCount = await seq.getVideoTrackCount();
  for (let t = 0; t < trackCount; t++) {
    n += (await (await seq.getVideoTrack(t)).getTrackItems(P.Constants.TrackItemType.CLIP, false)).length;
  }
  return n;
}


/**
 * Collapse every video track onto V1, top layer winning.
 *
 * This is the tedious part of prepping for grade done by hand: an editor stacks
 * a shot on V2 rather than cutting it into V1, and someone later has to bring it
 * all down to one layer so the colourist gets a single stream of shots.
 *
 * The mechanism is `createCloneTrackItemAction(item, TIME_ZERO, -trackIndex, 0,
 * true, false)` - a clone with a vertical offset and `isInsert` FALSE, which
 * makes it an OVERWRITE. That is the whole trick: the overwrite trims whatever
 * it lands on, so the top clip wins and the clip beneath is cut back
 * automatically. No in/out-point arithmetic, which is the part that would
 * otherwise go wrong and put the wrong frames on screen.
 *
 * Tracks are processed BOTTOM-UP (V2, then V3, then V4...) so the highest track
 * is written last and therefore wins, which is what "the layer on top wins"
 * means.
 *
 * Clips are moved, not copied: each original is removed once its copy has
 * landed on V1.
 */
async function flattenToSingleTrack(sequenceRef) {
  const P = ppro();
  const project = await getActiveProject();
  const sequence = await resolveSequence(sequenceRef);
  const CLIP = P.Constants.TrackItemType.CLIP;
  const trackCount = await sequence.getVideoTrackCount();
  const moved = [];
  const failed = [];

  // REFUSE while an adjustment layer is present. This is not defensive
  // programming for its own sake - it was measured. A LUT adjustment layer
  // spanning 0-55.56s on V8 flattened down onto V1 and overwrote every shot in
  // the film: 37 clips became 3. An adjustment layer is pass-through and
  // full-length, so as the top layer it wins everywhere, and "top wins" turns
  // into "delete the entire edit".
  for (let t = 0; t < trackCount; t++) {
    const items = await (await sequence.getVideoTrack(t)).getTrackItems(CLIP, false);
    for (const item of items) {
      let isAdj = false;
      try { isAdj = await item.isAdjustmentLayer(); } catch (e) { isAdj = false; }
      if (isAdj) {
        throw new Error(
          "Refusing to flatten: an adjustment layer is still on V" + (t + 1) +
          ". Flattening one down would overwrite every clip beneath it and empty the " +
          "timeline. Switch on \u201CRemove adjustment layers\u201D and run again.");
      }
    }
  }

  // Ascending, so higher tracks overwrite later and win.
  for (let t = 1; t < trackCount; t++) {
    // Re-fetch the track on every pass and always take the FIRST remaining
    // clip. Holding a whole track's handles while awaiting a getName() per clip
    // is the stale-handle trap that broke removeHiddenClips; and because each
    // original is removed once its copy lands, "first remaining" always
    // advances. `guard` stops the loop if a clip cannot be moved, so a failure
    // cannot spin forever.
    let guard = 0;
    while (guard < 10000) {
      guard++;
      const items = await (await sequence.getVideoTrack(t)).getTrackItems(CLIP, false);
      if (!items.length) break;
      const item = items[0];
      const name = await item.getName();
      let ok = false;
      try {
        project.lockedAccess(() => {
          const editor = P.SequenceEditor.getEditor(sequence);
          const action = editor.createCloneTrackItemAction(item, P.TickTime.TIME_ZERO, -t, 0, true, false);
          project.executeTransaction((c) => { c.addAction(action); }, "Flatten to V1");
        });
        ok = true;
      } catch (e) {
        failed.push({ track: "V" + (t + 1), name, error: String(e.message || e) });
      }
      // A clip that could not be copied down must end the pass on this track,
      // or the loop would meet it again forever.
      if (!ok) break;

      // Remove the original only once its copy has landed, so a failure
      // half-way leaves the clip where it was rather than losing it.
      try {
        project.lockedAccess(() => {
          const editor = P.SequenceEditor.getEditor(sequence);
          let selection = null;
          P.TrackItemSelection.createEmptySelection((sel) => { selection = sel; });
          selection.addItem(item, true);
          const action = editor.createRemoveItemsAction(selection, false, P.Constants.MediaType.VIDEO, false);
          project.executeTransaction((c) => { c.addAction(action); }, "Remove flattened original");
        });
        moved.push({ track: "V" + (t + 1), name });
      } catch (e) {
        failed.push({ track: "V" + (t + 1), name, error: "copied down but the original could not be removed: " + (e.message || e) });
        break;   // the clip is still there; stop rather than loop on it
      }
    }
  }

  // Report what is actually left above V1, so a partial result is visible.
  let leftAbove = 0;
  for (let t = 1; t < trackCount; t++) {
    leftAbove += (await (await sequence.getVideoTrack(t)).getTrackItems(CLIP, false)).length;
  }
  const onV1 = (await (await sequence.getVideoTrack(0)).getTrackItems(CLIP, false)).length;
  return { moved, failed, leftAbove, onV1 };
}


// ---------------------------------------------------------------------------
// Phase 4 - mix timeline
// ---------------------------------------------------------------------------

/**
 * Audio components that survive "remove effects" on the Mix timeline.
 *
 * These are the audio equivalents of Motion and Opacity - fixed components that
 * carry the clip's LEVELS, not an effect anyone would call an effect. Measured
 * on the test teaser, whose 134 audio clips carry nothing else: Internal
 * Volume Mono on 131 of them, Internal Volume Stereo and Internal Channel
 * Volume Stereo on three each.
 *
 * Stripping these would wipe every level and pan decision in the edit and hand
 * the mixer a flat, unbalanced timeline - far worse than leaving a plugin on.
 */
var KEEP_AUDIO_COMPONENTS = /^Internal (Volume|Channel Volume|Pan|Balance)/i;

/** Remove every clip from the VIDEO tracks, leaving audio. Mirror of stripAudioClips. */
async function stripVideoClips(sequenceRef) {
  const P = ppro();
  const project = await getActiveProject();
  const sequence = await resolveSequence(sequenceRef);
  const count = await sequence.getVideoTrackCount();
  let removed = 0;

  for (let i = 0; i < count; i++) {
    const track = await sequence.getVideoTrack(i);
    const items = await track.getTrackItems(P.Constants.TrackItemType.CLIP, false);
    if (!items.length) continue;
    project.lockedAccess(() => {
      const editor = P.SequenceEditor.getEditor(sequence);
      let selection = null;
      P.TrackItemSelection.createEmptySelection((sel) => { selection = sel; });
      if (!selection) throw new Error("Could not build a selection to strip video with.");
      items.forEach((it) => { try { selection.addItem(it, true); } catch (e) { /* already present */ } });
      const action = editor.createRemoveItemsAction(selection, false, P.Constants.MediaType.VIDEO, false);
      project.executeTransaction((c) => { c.addAction(action); }, "Strip video");
    });
    removed += items.length;
  }
  return removed;
}

/**
 * Walk the audio clips: strip real effects if asked, always keeping levels.
 */
async function processMixClips(sequenceRef, opts) {
  const P = ppro();
  const project = await getActiveProject();
  const sequence = await resolveSequence(sequenceRef);
  const CLIP = P.Constants.TrackItemType.CLIP;
  const trackCount = await sequence.getAudioTrackCount();
  const summary = { clips: 0, effectsRemoved: 0, removedNames: {}, keptLevels: 0 };

  for (let t = 0; t < trackCount; t++) {
    const items = await (await sequence.getAudioTrack(t)).getTrackItems(CLIP, false);
    for (const item of items) {
      summary.clips++;
      if (!opts.removeEffects) continue;

      const chain = await item.getComponentChain();
      const count = await chain.getComponentCount();
      const components = [];
      for (let i = 0; i < count; i++) {
        const c = await chain.getComponentAtIndex(i);
        components.push({ component: c, matchName: await c.getMatchName() });
      }
      const doomed = components.filter((c) => !KEEP_AUDIO_COMPONENTS.test(c.matchName));
      summary.keptLevels += components.length - doomed.length;
      if (!doomed.length) continue;

      project.lockedAccess(() => {
        const actions = doomed.map((d) => chain.createRemoveComponentAction(d.component));
        project.executeTransaction((c) => { actions.forEach((a) => c.addAction(a)); }, "Remove audio effects");
      });
      doomed.forEach((d) => {
        summary.removedNames[d.matchName] = (summary.removedNames[d.matchName] || 0) + 1;
      });
      summary.effectsRemoved += doomed.length;
    }
  }
  return summary;
}

/**
 * Export the mix timeline as AAF.
 *
 * Signature established by trial, since the type definitions do not mention AAF
 * at all and native arity reports 0:
 *
 *     exportAAF(sequence, outputPath, options?, suppressUI?)
 *
 * Passing the project first throws "Illegal Parameter type".
 *
 * `AAFExportOptions` IS honoured - proven by turning on mixdownVideo, which
 * took the same sequence from a 3 MB reference AAF to a **2.9 GB** file plus a
 * 1.5 GB Rendered.mxf beside it. It is exposed in the panel because Premiere's
 * dialog exposes it, but it defaults off and the panel warns what it costs.
 *
 * `renderAudioEffects` is the flag that bakes audio effects into the exported
 * media - the "Render and Replace" the build spec planned as an
 * export-and-reimport subsystem, available here as one option.
 */
async function exportAAF(sequenceId, outputPath, options) {
  const P = ppro();
  const project = await getActiveProject();
  const seq = await resolveSequence(sequenceId);
  const opts = options || {};

  if (!nativeExport("aaf")) {
    const bridge = cepBridge();
    const r = await bridge.request("exportAAF", {
      sequenceId: String(sequenceId), sequenceName: seq.name, outputPath, options: opts
    });
    if (!r.fileExists) {
      throw new Error("The CEP bridge reported the AAF as exported, but no file exists at " +
                      outputPath + ". The destination folder has probably been moved or " +
                      "deleted since it was chosen — pick it again.");
    }
    return {
      exported: true,
      path: outputPath,
      via: "cep",
      bytes: r.bytes,
      mediaFiles: r.mediaFiles,
      matchedBy: r.matchedBy,
      // ExtendScript cannot read options back, so these are what was ASKED
      // for - and ignoredOptions says which of those 25.x does not act on.
      settings: Object.assign({}, opts),
      ignoredOptions: bridge.ignoredAafOptions(opts)
    };
  }

  // One setter per control in Premiere's own AAF Export Settings dialog, in the
  // same order, so the panel and the dialog can be read side by side.
  //
  // Premiere's dialog also offers "Use tape sources when present"; the API has
  // no property for it, so the panel omits it rather than showing a control
  // that does nothing.
  const aafOptions = new P.AAFExportOptions();
  aafOptions.setMixdownVideo(!!opts.mixdownVideo);
  aafOptions.setExplodeToMono(!!opts.explodeToMono);                       // Breakout to Mono ▸ Enable
  aafOptions.setRenderAudioEffects(!!opts.renderAudioEffects);             // Render audio clip effects
  aafOptions.setInterleaveWithoutEffects(!!opts.interleaveWithoutEffects); // Include clip copies without effects
  aafOptions.setSampleRate(opts.sampleRate || 48000);                      // Sample Rate
  aafOptions.setBitsPerSample(opts.bitsPerSample || 24);                   // Bits per Sample
  aafOptions.setEmbedAudio(!!opts.embedAudio);                             // Files: Embedded vs Separate
  aafOptions.setPreserveParentFolder(!!opts.preserveParentFolder);         // Preserve media directory name
  aafOptions.setAudioFileFormat(
    opts.audioFileFormat === undefined
      ? P.ProjectConverter.AAF_EXPORT_AUDIO_FORMAT_WAV
      : opts.audioFileFormat);                                             // Format: Broadcast Wave / AIFF
  aafOptions.setTrimSources(!!opts.trimSources);                           // Render: Trim vs Copy Complete
  aafOptions.setHandleFrames(opts.handleFrames || 0);                      // Handle Frames

  const exported = await P.ProjectConverter.exportAAF(seq, outputPath, aafOptions, true);
  return {
    exported,
    path: outputPath,
    via: "uxp",
    // Read back rather than echoing what was asked for, so the report shows
    // what the exporter actually holds.
    settings: {
      mixdownVideo: aafOptions.mixdownVideo,
      explodeToMono: aafOptions.explodeToMono,
      renderAudioEffects: aafOptions.renderAudioEffects,
      interleaveWithoutEffects: aafOptions.interleaveWithoutEffects,
      sampleRate: aafOptions.sampleRate,
      bitsPerSample: aafOptions.bitsPerSample,
      embedAudio: aafOptions.embedAudio,
      preserveParentFolder: aafOptions.preserveParentFolder,
      audioFileFormat: aafOptions.audioFileFormat,
      trimSources: aafOptions.trimSources,
      handleFrames: aafOptions.handleFrames
    }
  };
}

/** Count the audio clips on a sequence. */
async function countAudioClips(sequenceId) {
  const P = ppro();
  const sequence = await resolveSequence(sequenceId);
  let n = 0;
  const trackCount = await sequence.getAudioTrackCount();
  for (let t = 0; t < trackCount; t++) {
    n += (await (await sequence.getAudioTrack(t)).getTrackItems(P.Constants.TrackItemType.CLIP, false)).length;
  }
  return n;
}

/** Find a bin by name anywhere in the tree, or create one at the root. */
async function ensureBin(name) {
  const P = ppro();
  const project = await getActiveProject();
  const existing = await findBins([name]);
  if (existing.bins[name] && existing.bins[name].found) {
    // Re-walk to get the live FolderItem for the path we found.
    const root = await project.getRootItem();
    const target = await findFolderByName(root, name);
    if (target) return { folder: target, created: false, path: existing.bins[name].path };
  }
  const root = await project.getRootItem();
  project.lockedAccess(() => {
    const action = root.createBinAction(name, true);
    project.executeTransaction((c) => { c.addAction(action); }, "Create " + name + " bin");
  });
  const made = await findFolderByName(root, name);
  return { folder: made, created: true, path: "/" + name };
}

async function findFolderByName(root, name) {
  const P = ppro();
  const wanted = String(name).toLowerCase();
  let frontier = [root];
  let budget = 20000;
  while (frontier.length && budget > 0) {
    const next = [];
    for (const node of frontier) {
      let items;
      try { items = await node.getItems(); } catch (e) { continue; }
      for (const item of items) {
        if (--budget <= 0) break;
        let folder = null;
        try { folder = P.FolderItem.cast(item); } catch (e) { folder = null; }
        if (!folder) continue;
        if (String(item.name).toLowerCase() === wanted) return folder;
        next.push(folder);
      }
    }
    frontier = next;
  }
  return null;
}

/** Move a sequence into a bin and colour it. */
async function fileSequence(sequenceRef, binName, colourIndex) {
  const project = await getActiveProject();
  const sequence = await resolveSequence(sequenceRef);
  const item = await sequence.getProjectItem();
  const bin = await ensureBin(binName);
  project.lockedAccess(() => {
    const actions = [];
    if (bin.folder) actions.push(bin.folder.createMoveItemAction(item, bin.folder));
    actions.push(item.createSetColorLabelAction(colourIndex));
    project.executeTransaction((c) => { actions.forEach((a) => c.addAction(a)); }, "File output sequence");
  });
  return bin;
}

/**
 * Write the run manifest onto the output sequence as a marker at 00:00:00:00,
 * so anyone opening it later can see what was applied without re-deriving it.
 */
async function writeRunManifest(sequenceRef, text) {
  const P = ppro();
  const project = await getActiveProject();
  const sequence = await resolveSequence(sequenceRef);
  const markers = await P.Markers.getMarkers(sequence);
  if (!markers) return false;
  const zero = P.TickTime.TIME_ZERO;
  project.lockedAccess(() => {
    const action = markers.createAddMarkerAction(
      "The Onliner", P.Marker.MARKER_TYPE_COMMENT, zero, P.TickTime.TIME_ZERO, text);
    project.executeTransaction((c) => { c.addAction(action); }, "Write run manifest");
  });
  return true;
}

/**
 * Load a sibling module from inside js/.
 *
 * Measured on Premiere 26.5.2 (Windows): a require() issued from a module
 * that was itself required - this file, loaded by app.js - resolves against
 * THAT MODULE'S folder, so "./js/platform" fails with "Parent module folder
 * was: /js". app.js, loaded by index.html, resolves against the plugin root
 * (docs/API-FINDINGS.md §8). Both shapes are tried so the loader's rule, which
 * differs between builds, cannot take the panel down at load.
 */
function requireSibling(name) {
  try { return require("./" + name); } catch (e) { return require("./js/" + name); }
}

/** A file Premiere just wrote, by name inside the picked folder, else by path. */
async function openExportedFile(outputPath, folderEntry) {
  const platform = requireSibling("platform");
  if (folderEntry && typeof folderEntry.getEntry === "function") {
    try {
      return await folderEntry.getEntry(platform.baseName(outputPath));
    } catch (e) { /* fall through to the path */ }
  }
  return await platform.openEntry(outputPath);
}

/**
 * Export the grade timeline as FCPXML, then COUNT WHAT ACTUALLY LANDED IN IT.
 *
 * FCP7 XML silently drops multicam clips. Measured on the test teaser: the
 * sequence held 49 video clips, 25 of them multicam, and the exported XML
 * contained 24 clipitems - every multicam shot gone, no error, no warning
 * anywhere. A colourist would open a timeline that looks plausible and is
 * missing half the film.
 *
 * Detecting multicam up front is not reliable here (UXP's `isSequence()`
 * returns false for them, unlike ExtendScript), so this verifies the
 * deliverable instead of trying to predict it: whatever the cause of a
 * shortfall, the count catches it.
 */
async function exportFCPXML(sequenceId, outputPath, expectedClipCount, folderEntry) {
  const P = ppro();
  const project = await getActiveProject();
  const seq = await project.getSequence(P.Guid.fromString(sequenceId));
  if (!seq) throw new Error("Sequence to export is not in the active project.");

  let exported, via = "uxp", matchedBy = null;
  if (nativeExport("fcpxml")) {
    exported = await P.ProjectConverter.exportAsFinalCutProXML(seq, outputPath, true);
  } else {
    // Premiere 25.x: no UXP export, so ExtendScript does it via the CEP
    // bridge. Everything below - file check, clipitem count - runs unchanged.
    const r = await cepBridge().request("exportFCPXML", {
      sequenceId: String(sequenceId), sequenceName: seq.name, outputPath
    });
    exported = !!r.exported;
    via = "cep";
    matchedBy = r.matchedBy || null;
  }
  const result = { exported, via, matchedBy, path: outputPath, expected: expectedClipCount, found: null, shortfall: 0 };
  if (!exported) return result;

  // Confirm the file is actually there. Exporting into a folder that no longer
  // exists - picked earlier, moved since - reports success and writes nothing,
  // and the failure then surfaces several steps later as an unhelpful "Could
  // not find an entry of file:///...".
  //
  // Looked up through the picked folder ENTRY when there is one: that stays
  // inside the scope the picker granted and needs no URL, on either platform.
  // The path route is the fallback for a caller with only a string.
  const file = await openExportedFile(outputPath, folderEntry);
  if (!file) {
    throw new Error("Premiere reported the FCPXML was exported, but no file exists at " +
                    outputPath + ". The destination folder has probably been moved or " +
                    "deleted since it was chosen — pick it again.");
  }

  try {
    const text = String(await file.read());
    const matches = text.match(/<clipitem\b/g);
    result.found = matches ? matches.length : 0;
    if (typeof expectedClipCount === "number" && result.found < expectedClipCount) {
      result.shortfall = expectedClipCount - result.found;
    }
  } catch (e) {
    result.verifyError = String(e.message || e);
  }
  return result;
}

module.exports = {
  isAvailable,
  cloneSequence,
  resolveSequence,
  renameSequence,
  stripAudioClips,
  removeDisabledClips,
  removeClipsOnHiddenTracks,
  removeAdjustmentLayers,
  removeHiddenClips,
  flattenToSingleTrack,
  stripVideoClips,
  processMixClips,
  exportAAF,
  countAudioClips,
  mergeIntervals,
  coverage,
  processGradeClips,
  ensureBin,
  fileSequence,
  writeRunManifest,
  exportFCPXML,
  scanMulticam,
  countVideoClips,
  COLOUR,
  createReferenceSequence,
  applyTimecodeBurnIn,
  queueExport,
  exportStillFrame,
  deleteSequenceById,
  readProjectSummary,
  listSequences,
  listSequenceNames,
  readSequenceShape,
  findBins,
  probeCapabilities
};
