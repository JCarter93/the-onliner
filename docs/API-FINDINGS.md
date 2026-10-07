# UXP API findings — checked against the running app, not the docs

Everything below was verified by introspecting **Premiere Pro 26.3.2** live
(`Object.getOwnPropertyNames` on the real `premierepro` module, and real calls
where they were read-only). Both 25.6.6 and 26.3.2 are installed on this
machine, so the manifest's `minVersion: 25.6.0` is satisfiable either way.

This file exists because the two obvious reference sources are both wrong in
ways that would have cost a phase each.

## 1. The bundled TypeScript definitions are stale — `exportAAF` is real

The `premierepro` type definitions ship without any mention of AAF. Searching
them for "AAF" returns nothing, and `ProjectConverterStatic` is declared as
exactly two methods:

```ts
exportAsFinalCutProXML(sequence, outputFilePath, suppressUI?): Promise<boolean>
exportAsOpenTimelineIO(sequence, outputFilePath, suppressUI?): Promise<boolean>
```

The runtime disagrees. `Object.getOwnPropertyNames(ppro.ProjectConverter)`:

```
exportAAF
AAF_EXPORT_AUDIO_FORMAT_AIFF   // 0
AAF_EXPORT_AUDIO_FORMAT_WAV    // 1
exportAsFinalCutProXML
exportAsOpenTimelineIO
```

There is also an undocumented `AAFExportOptions` class. It constructs with
`new ppro.AAFExportOptions()` and carries a getter/setter pair for each option:

| Option | Default |
| --- | --- |
| `mixdownVideo` | `false` |
| `explodeToMono` | `false` |
| `sampleRate` | `48000` |
| `bitsPerSample` | `16` |
| `embedAudio` | `false` |
| `audioFileFormat` | `0` (AIFF) |
| `trimSources` | `false` |
| `handleFrames` | `0` |
| `videoMixdownPresetPath` | — |
| `renderAudioEffects` | `false` |
| `interleaveWithoutEffects` | `false` |
| `preserveParentFolder` | `false` |

**Consequence for the build spec.** The spec's premise for choosing UXP holds
up — AAF export is there — but only by luck: the reasoning cited the docs, and
the docs say it does not exist. Take the runtime as the authority throughout.

**`renderAudioEffects` matters for Phase 4.** The spec plans a manual
export-and-reimport to imitate "Render and Replace". AAF export can render
audio effects itself. That is worth testing before building the manual path,
because it is one flag against a whole subsystem. It is not a straight
substitute — it bakes effects into the AAF's media rather than into the
Premiere sequence — so the panel keeps both options, but Phase 4 should try
this first.

**Arity is not a signature.** Both `exportAAF.length` and
`exportAsFinalCutProXML.length` report `0`, as native bindings do. The
FCPXML argument order is known from the type defs; **`exportAAF`'s is not**
and must be established by trial on a scratch project, never on an editor's
live one.

## 2. `ProjectConverter` is the only export route — there is no `Exporter` for this

`ppro.Exporter` exists but carries exactly one method, `exportSequenceFrame`.
Sequence export for delivery goes through `EncoderManager`:

```ts
EncoderManager.getManager()
  .exportSequence(sequence, exportType, outputFile?, presetFile?, exportFull?)
```

with `EXPORT_QUEUE_TO_AME`, `EXPORT_QUEUE_TO_APP` and `EXPORT_IMMEDIATELY` as
the export types, and `EVENT_RENDER_COMPLETE` / `_ERROR` / `_CANCEL` /
`_QUEUE` / `_PROGRESS` to follow the job. `isAMEInstalled` is a property, not
a method.

## 3. The timecode burn-in effect exists, and its match name is not obvious

Of 194 video filters on this build, exactly one matches:

```
display name: "Metadata & Timecode Burn-in"
match name:   "AE.ADBE PPro Metadata"
```

The match name gives no hint of timecode. Resolve it by display name once at
startup and cache the match name — Adobe changes display strings between
versions more readily than match names, and `VideoFilterFactory.createComponent`
takes the match name.

## 4. Time Remapping really is invisible — confirmed, not assumed

Walking the component chain of real clips on the active sequence returns only:

```
AE.ADBE Opacity  — Opacity, Blend Mode
AE.ADBE Motion   — Position, Scale, Scale Width, Rotation, Anchor Point,
                   Anti-flicker Filter, Crop Left/Top/Right/Bottom
```

No Time Remapping component, on any clip. This confirms Section 2 of the spec:
it cannot be detected this way, so the flagging has to come from somewhere
else, or the panel warns generically. **Phase 3 needs a decision here** — see
"Open question" below.

**Also worth noting: Opacity is a fixed effect too.** The spec calls out Motion
as resettable-but-not-removable; Opacity is in the same position and the same
chain. "Remove other applied effects" must skip both, or it will throw.

Motion's parameters are addressed by index, and the list contains a param whose
display name is a single space (`" "`) sitting between Scale Width and
Rotation. Match on display name, not on a hard-coded index.

## 5. Writes go through one transaction — one undo step

```ts
project.executeTransaction(callback: (compoundAction) => void, undoString?): boolean
project.lockedAccess(callback: () => void): void
```

Every mutation is an `Action` pushed into the compound action. This is what
keeps a panel run to a single Cmd-Z for the editor, and it is why `js/ppro.js`
is shaped around building actions rather than calling setters.

## 6. The pieces the naming and organisation rules need all exist

- `FolderItem.createBinAction(name, makeUnique)` — the `FOR_GRADE` / `FOR_MIX` bins
- `FolderItem.createMoveItemAction(item, newParent)` — putting outputs in them
- `ProjectItem.createSetColorLabelAction(index)` and the `ProjectItemColorLabel`
  enum (`VIOLET`, `IRIS`, …) — the per-type colour label
- `Sequence.createCloneAction()` — the duplicate that Grade and Mix both start from
- `Markers` via `getMarkers(sequenceOrProjectItem)` — the run manifest

## 7. `getSequence(guid)` returns a Promise the type defs deny

Declared as returning a `Sequence` directly:

```ts
getSequence(guid: Guid): Sequence      // no Promise
```

It returns a Promise. Unawaited you get an object with none of the Sequence
methods, and the first call fails with a message that points nowhere useful:

```
seq.getVideoTrackCount is not a function
```

`getSequences()` and `getActiveSequence()` both hand back real `Sequence`
objects, so the failure only shows on the by-guid path - which is the one a
panel with a sequence picker uses. **Await it.** A third instance of the same
lesson: the type definitions are a hint, the runtime is the authority.

## 8. Two install-time traps, both silent

**Premiere does not scan the plugins folder.** Dropping an unpacked plugin into
`~/Library/Application Support/Adobe/UXP/Plugins/External/<id>_<version>/` does
nothing on its own. The loader reads a registry:

```
~/Library/Application Support/Adobe/UXP/PluginsInfo/v1/premierepro.json
```

An unregistered plugin is ignored with no error anywhere — not in the panel
list, not in the UXP log. `scripts/install-dev.sh` writes the entry (and leaves
the other plugins in the file alone). The log line that confirms it worked:

```
upic::plugin with id: theonliner is added in uxp plugin manager with status as enabled
upic::Number of plugins added from user's pluginsInfo: 2
```

A symlink in the External folder is followed fine, so the working copy does not
have to be copied on every edit.

**Closing and reopening the panel does NOT reload its code — only restarting
Premiere does.** The panel redraws from the build it was loaded with, so edits
appear to have no effect and you debug a bug you have already fixed. There is
no UXP Developer Tool installed here to force a reload, so the dev loop is:
edit, restart Premiere, test. Budget for it, and batch changes rather than
testing one at a time. The giveaway is a panel still showing text that no
longer exists anywhere in the source.

**`require()` resolves against the plugin root, not the requiring file.** From
`js/app.js`, `require("./prefs")` fails even though `js/prefs.js` is its
sibling:

```
Error: Module not found: "./prefs". Parent module folder was: "./".
    at js/app.js:11:15
```

Paths must be root-relative — `require("./js/prefs")`. This is why the
one third-party plugin on this machine keeps every module at its root; it sidesteps the problem
rather than solving it. Worth knowing that a failure here is an **uncaught JS
exception in the UXP log only** — the panel renders its HTML and simply does
nothing, with no visible error.

## 9. Phase 2: what the burn-in actually required

**There is no way to create an adjustment layer.** `isAdjustmentLayer()` can
detect one; nothing creates one. Confirmed against the live `Project` object,
whose full method list contains no adjustment, synthetic, matte or colour-matte
creator. The build spec's plan — "via an adjustment layer to avoid touching the
original clips" — cannot be implemented as written.

**Nesting reaches the same end, more cleanly.** A sequence's project item casts
to `ClipProjectItem`, so `createSequenceFromMedia(name, [thatItem])` builds a
new sequence whose V1 holds the entire source programme as one track item,
sized to match (a 1280x720 source produced a 1280x720 reference, not the
1920x1080 default). One track item is one component chain to burn into, and the
source sequence is never opened, let alone modified — strictly safer than an
adjustment layer added to the original.

**Component actions only work inside `lockedAccess`, with no `await` between
acquiring a handle and using it.** Outside it,

```js
chain.createAppendComponentAction(component)
```

throws `The script object is no longer valid.` — every time, on nests and on
ordinary clips, with the burn-in and with Gaussian Blur, so it is not about
this effect or this kind of clip. The fix is to gather every handle first, then
do all the action creation and `executeTransaction` synchronously:

```js
const action = chain.createAppendComponentAction(component);   // inside...
project.lockedAccess(() => {
  project.executeTransaction((c) => { c.addAction(action); }, "Add burn-in");
});
```

This is the same error text that shows up transiently elsewhere, which makes it
easy to dismiss as a flake and retry — it is not, it is completely reproducible.

**The action must be CREATED inside the callback, not merely executed there.**
This is the part that is easy to get wrong even with the rule written down, and
it shipped once:

```js
const a = chain.createAppendComponentAction(c);        // WRONG - throws
project.lockedAccess(() => { project.executeTransaction(...); });

project.lockedAccess(() => {                            // RIGHT
  const a = chain.createAppendComponentAction(c);
  project.executeTransaction((t) => t.addAction(a), "…");
});
```

The symptom is specific and misleading: the plain reference export works fine
and only the burn-in fails, because only the burn-in touches a component chain.
`tests/locked-access-test.js` now enforces this structurally, since no unit test
can reach it.

**The burn-in renders nothing as applied.** "Metadata & Timecode Burn-in" has
67 parameters: two effect-wide (`Size` 15, `Opacity` 40) then five 13-parameter
blocks, one per text line. **All five lines default to off.** Applying the
effect and stopping there produces a reference export that looks clean and
carries no timecode at all — the worst kind of failure, since nothing errors.
`Line 1` must be switched on explicitly.

**Boolean parameters write but do not read back.** After switching `Line 1` on,
`getValueAtTime` still reports `false`, while numeric writes in the same
transaction (`Size` 25, `Opacity` 100) read back correctly. The write really
does take — a rendered frame proves it. **Do not assert on a boolean param
read-back**; verify by rendering.

**`createComponent` returns an opaque handle** — a `VideoFilterComponent` whose
prototype is empty. It has no `getMatchName`, no `getParamCount`; it exists
only to be passed to a chain action. To inspect what landed, re-read the chain.

**`Exporter.exportSequenceFrame` needs an extension in the filename**, or it
fails with `Internal error : File Format is not supported`.

### How Phase 2 was signed off

A frame rendered from the reference sequence at 2 seconds reads
`00:00:02:00` — sequence timecode, matching exactly. The control frame from the
untouched source at the same time is the same picture with no burn-in. The
source sequence's clip chain still held only Opacity and Motion afterwards.

## 10. Phase 3: what the pre-flight caught

Every one of these was found by running the engine against a throwaway clone of
a real sequence before wiring it to the panel. None would have been caught by
reading the docs or the type definitions.

**The lockedAccess rule is wider than component chains.** `createCloneAction`,
`createSetNameAction`, `createBinAction`, `createSetColorLabelAction` and
`createAddMarkerAction` all fail the same way when created outside it. The
static guard in `tests/locked-access-test.js` was originally scoped to
component and parameter actions and missed all five; it now matches every
`create*Action` call.

**It is not only about where the action is created — every handle it is built
from must be fresh.** `SequenceEditor.getEditor(sequence)` fetched once before
a loop and used after a few `await`s throws "The script object is no longer
valid" and removes nothing. Acquire the editor and the selection inside the
`lockedAccess` callback, at the point of use.

**Never build a removal against `sequence.getSelection()`** — that is whatever
the editor has selected in the timeline right now. Use
`TrackItemSelection.createEmptySelection`, which does hand back a selection that
survives outside its callback.

**Values handed to an action must be built inside `lockedAccess` as well.** A
`PointF` constructed while gathering targets, then used inside the transaction,
throws "The script object is no longer valid" — the third variant of the same
rule, after actions and handles. Carry the spec and build the value at the point
of use. This one survived a pre-flight because the hand-written mirror happened
to build the value inside the callback while the real module built it outside:
**a mirror is not a test of the code it mirrors.** The static guard now checks
value builders as well as action call sites.

**Point parameters read and write asymmetrically.** `getValueAtTime` returns a
plain Array for Position and Anchor Point, but `createKeyframe` rejects an Array
with `Illegal Parameter type` and requires a real `PointF`. Feeding back the
exact value you just read fails. Scalars round-trip fine, which is what makes it
easy to miss — and **one bad parameter aborts the entire transaction**, so a
failing Position write silently loses the Scale and Rotation resets with it.
That is how a first pass came back with all 49 clips unreset.

**Tracks cannot be deleted, only emptied.** Stripping audio leaves the audio
tracks in place — 16 of them, empty. The exported XML shows this as 40 tracks,
32 of them empty.

### The one that matters most: FCP7 XML silently drops multicam clips

Measured on the teaser it was built against. The sequence held **49 video clips, 25 of them
multicam**. The exported FCPXML contained **24 clipitems** — every multicam shot
gone. No error, no warning, nothing in any log. Per track: V1 20 clips → 6 in
the XML, V2 15 → 7, V3 7 → 6.

A colourist would open that timeline, see something plausible, and conform a
film missing half its shots.

**Multicam clips CAN be detected**: `ClipProjectItem.isMulticamClip()` exists
and works — verified true on the synced multicam clips and false on camera originals.
(`ProjectItem.isSequence()` is a red herring here: on a track item's project
item it does not return false, it **throws** `isSequence is not a function`,
which is easy to swallow in a catch and misread as a negative result.) So the
panel names the offending clips up front rather than inferring a problem from a
count.

`exportFCPXML` ALSO verifies the artefact — reads the file back, counts
`<clipitem` elements, compares against the timeline and warns on a shortfall.
Belt and braces: the per-clip check explains what to fix, the count catches
anything else that silently drops.

### Multicam cannot be flattened from the API

The obvious fix — flatten multicam to camera originals before export — is not
available. `ProjectItem.getSequence()` on a multicam item returns **null**, so
the backing angle stack is unreachable, and `TrackItem`'s complete method list
contains nothing about angles or cameras:

```
createAddVideoTransitionAction, createRemoveVideoTransitionAction, getMatchName,
getName, getIsSelected, getSpeed, isAdjustmentLayer, isSpeedReversed,
createMoveAction, getInPoint, getOutPoint, createSetInPointAction,
createSetOutPointAction, getStartTime, getEndTime, createSetStartAction,
createSetEndAction, getDuration, getType, isDisabled, createSetDisabledAction,
createSetNameAction, getMediaType, getTrackIndex, getProjectItem,
getComponentChain
```

Which angle a given cut is using is simply not exposed. A tool that flattened
anyway would have to guess the camera, and would put the **wrong shot** in the
film — worse than dropping it, because the result looks correct. Flattening
stays a manual step in Premiere, on a duplicate, before the panel runs.

## 11. Disabled clips

`TrackItem.isDisabled()` reports clips switched off in the edit. They are
invisible in the programme but fully present in the timeline, and they **export
into the FCPXML like any other clip** — so a colourist conforming the handoff
receives shots the edit had deliberately killed.

This is not a rare tidiness issue. Measured across four real sequences from
one job:

| Sequence | Video clips | Disabled |
| --- | --- | --- |
| the teaser | 49 | 9 |
| main cut A | 132 | 6 |
| main cut B | 135 | 1 |
| **main cut C** | **309** | **100** |

A third of the last one would have arrived in the grade as live shots.

**Ripple must be false.** `createRemoveItemsAction(selection, ripple, mediaType,
shiftOverLapping)` with ripple `true` would close the gaps and shift every clip
after each removal, so the conform would no longer line up with picture. The gap
a disabled clip leaves is correct — nothing was showing there anyway. Verified
on a clone of the teaser: 49 clips to 40, 9 removed, and **0 surviving clips
moved**, compared by start tick.

Removal runs **before** the clip walk, so disabled clips are not reset, not
counted in the report, and cannot trip the multicam gate for a shot that is on
its way out.

## 12. Adjustment layers and hidden clips

**Adjustment layers are clips, not effects**, so "remove other applied effects"
never touched them. In an offline they are almost always carrying the temp
grade: the V6 teaser had two, on V8 (0–55.56s) and V2 (55.56–58.76s),
which between them blanket the entire film. `TrackItem.isAdjustmentLayer()`
finds them.

**Clips fully covered by a higher track are invisible but still conform.** In
the same sequence, five clips were completely hidden — e.g. V1 `A004R027`
(12.32–14.64) sitting exactly under V3 `C004R026` (12.32–14.64). All five would
have reached the colourist as live shots.

Three deliberate limits, because deleting something still on screen is the worst
outcome this tool can produce:

- **Adjustment layers never count as covering.** They are pass-through. A LUT
  layer spanning the film would otherwise mark every clip beneath it hidden and
  empty the timeline.
- **Only FULL coverage is removed.** Partly-covered clips are kept and listed —
  trimming to the visible part would change the edit. Four in this sequence.
- **Alpha cannot be detected**, so a logo or matte covering the time range
  without hiding the picture would look like a cover. Hence the option, and
  hence every removal is reported with the clip that covered it.

`getStartTime().ticks` is a **string**; `Number()` converts it exactly at these
magnitudes (254,016,000,000 ticks/second, so a minute is ~1.5e13, well inside
2^53).

### Flattening to a single video track — an overwrite clone does it

`createCloneTrackItemAction(item, TIME_ZERO, -trackIndex, 0, true, false)` — the
final `false` is `isInsert`, making it an **overwrite**. That is the whole
trick: the overwrite trims whatever it lands on, so the top clip wins and the
clip beneath is cut back automatically. No in/out-point arithmetic, which is
the part that would otherwise put the wrong frames on screen.

Tracks are walked **bottom-up** (V2, then V3, then V4…) so the highest track is
written last and wins. Each original is removed only after its copy has landed,
so a mid-run failure leaves the clip where it was rather than losing it.

Measured on the V6 teaser: 37 clips across V1/V2/V3/V6/V8 became 30 on a single
V1 track, no overlaps, 63.20s continuous. Top-wins is visible in the result —
`B002L002` was 2.20–6.32 and came out 2.84–6.32, trimmed back by the V6 clip
that landed on top of it.

### Flattening MUST run after adjustment layers are removed

Not a theoretical concern — it was measured. A LUT adjustment layer spanning
0–55.56s on V8 flattened down onto V1 and **overwrote every shot in the film:
37 clips became 3.** An adjustment layer is pass-through and usually
full-length, so as the top layer it wins everywhere, and "top wins" becomes
"delete the entire edit".

Guarded in two places: `processBlockReason` refuses the combination before the
run starts, and `flattenToSingleTrack` throws if it finds an adjustment layer
anywhere. Both are covered by tests.

## 13. A Sequence object does not survive a pipeline

Held from the clone, through strip / remove-disabled / remove-adjustment /
remove-hidden / flatten, and then handed to the clip walk, a `Sequence` goes
stale. A real run flattened 12 clips successfully and died on the very next
call with "The script object is no longer valid".

The fix is structural, not another patch: **the grade pipeline passes GUID
strings between stages and every function re-resolves at entry** via
`resolveSequence(ref)`. Ten entry points do this, and
`tests/locked-access-test.js` asserts that each pipeline function calls it.

This is the fourth face of one rule — actions, handles, values, and now the
sequence itself. If something came from a previous `await`, assume it is dead.

### Test the real module, not a copy of it

Two failed runs came from pre-flighting a **hand-written mirror** of the module
rather than the module. Both times the mirror happened to do the right thing
where the real code did the wrong one — it built a `PointF` inside
`lockedAccess`, and it re-fetched the sequence each stage.

The module can be executed for real from a scripting context: read
`js/ppro.js` off disk with `localFileSystem.getEntryWithUrl`, evaluate it with
`new Function("module", "exports", "require", source)`, and call its actual
exports. The whole grade pipeline was verified that way — 134 audio clips
stripped, 8 disabled, 2 adjustment layers, 5 hidden, 12 flattened onto a single
V1, Motion reset on all 29, filed and manifested — using the same functions the
panel calls.

## 14. Empty tracks: strip them from the XML, not the sequence

`Premiere has no track add or delete`, so a grade sequence always carries the
source's full track count. The V6 teaser exported **10 video tracks with clips
on one, and 30 audio tracks with clips on none**.

The deliverable is a file, so they come out of the XML instead — same result
for the colourist, and the Premiere sequence is untouched. `js/fcpxml.js` does
it by scanning text (UXP has no XML DOM), which is normally a bad idea, so:

- The **clipitem count must be identical before and after**, or it throws and
  the file on disk is left exactly as Premiere wrote it.
- The file is only overwritten after that check passes.
- `<trackinfo>` and similar are not mistaken for `<track>`.
- Removing an empty track never changes layer order — populated tracks keep
  their relative sequence, the gaps just close.

Measured on the real export: **39 empty tracks removed, 1 kept, all 29 clips
intact**, file 16% smaller, still valid XML.

`findElementEnd` must start scanning **after** the element's own opening tag.
Counting it as nesting made the first version find no tracks at all and report
a cheerful "0 removed" — a silent no-op, which is why the tests assert the
removal counts and not just the clip survival.

## 15. Phase 4: AAF export

**Signature, established by trial** (the type defs do not mention AAF and native
arity reports 0):

```js
ProjectConverter.exportAAF(sequence, outputPath, options?, suppressUI?)
```

Passing the project first throws `Illegal Parameter type`. The shape mirrors
`exportAsFinalCutProXML`. Export takes several seconds, so a 20-second tool
timeout is not evidence of failure — check the file.

**`AAFExportOptions` IS honoured**, proven unmistakably: the same sequence
exported as a **3 MB** reference AAF with defaults, and as a **2.9 GB** file
plus a **1.5 GB** `Rendered.mxf` beside it with `mixdownVideo` on. (A single
option like `embedAudio` on its own produced a byte-identical size, which is
misleading — do not conclude the options are ignored from one flag.)

`mixdownVideo` is therefore forced **off**: a mixer has no use for a video
render, and nothing warns before it writes gigabytes.

**`renderAudioEffects` is the "Render and Replace" the spec planned as an
export-and-reimport subsystem.** It bakes audio effects into the media the AAF
writes. The effects stay visible in the Premiere sequence and arrive rendered
in the AAF — the same practical outcome with far less to go wrong.

### Audio "effects" are mostly levels, and must be kept

The teaser's 134 audio clips carry **only** fixed components: `Internal Volume
Mono` (131), `Internal Volume Stereo` (3), `Internal Channel Volume Stereo`
(3) — the audio equivalents of Motion and Opacity. Stripping them would wipe
every level and pan decision in the edit and hand the mixer a flat timeline,
which is worse than leaving a plugin on. `KEEP_AUDIO_COMPONENTS` matches
`Internal (Volume|Channel Volume|Pan|Balance)`.

Verified on a real run: 137 components across 134 clips, **0 removed, 137
kept** — every one was a level.

### Disabled clips matter to the mixer too

The same removal serves both departments, so it takes a media kind rather than
existing twice. `isDisabled()` answers on audio track items exactly as it does
on video.

Measured on the teaser: **25 disabled audio clips** — `WLDTT01.WAV`, `3T03` and
others, muted in the edit but which would have travelled to the mixer in the
AAF. 134 audio clips down to 109, with the 44 video clips untouched, confirming
an audio-kind removal stays on the audio tracks.

Ripple stays FALSE here for the same reason as picture: closing the gaps would
shift everything after each removal and the audio would no longer sync.

## 16. Premiere writes a translation report next to every FCPXML

`FCP Translation Results <timestamp>.txt`, in the same folder as the XML. It
lists everything the export could not carry, and it is worth reading:

```
Sequence <..._FOR_GRADE_v05> at , video track 1:
    Effect <Warp Stabilizer> on Clip <C006R029_260310KZ> not translated.
```

```
Synthetic Item (Black Video) not translated, Slug used as a placeholder.
```

**This corrects an earlier assumption in this document.** Warp Stabilizer is
kept rather than stripped on the grounds that removing it would hand the
colourist shaky shots that no longer match the offline — but FCP7 XML cannot
carry it either way, so those shots arrive unstabilised regardless. Keeping it
preserves the intent in the Premiere sequence, not in the deliverable. The
panel now says exactly that instead of implying the conform will match.

**The panel now reads it after every FCPXML export and surfaces the contents**
(`readTranslationReport` in `js/fcpxml.js`), so any future "not translated"
case is caught without anyone knowing the file exists.

Two details that matter for finding the right report: they are named by
timestamp, not by sequence, so several accumulate in a destination folder — the
correct one is identified by the **sequence name inside the file**, not by
picking the newest, which would grab someone else's export that happened to
land in the same folder. And Premiere repeats an identical issue once per
affected instance, so messages are de-duplicated before display.

## 17. Track item handles go stale too — and the odds scale with clip count

`removeHiddenClips` failed intermittently with "The script object is no longer
valid" after removing the adjustment layers. It was the only remover that read
**every track's items up front** — coverage cannot be judged one track at a
time — and by the time it removed from the first track, those handles had
survived dozens of `await`s.

It passed every test I ran and failed for the editor. That is the shape of this
bug: the odds scale with how many awaits happen between fetching a handle and
using it, so a small sequence passes and a real one does not.

**The pattern that fixes it: record POSITIONS, not handles.** Decide what to
remove using indices, then re-fetch the track's items immediately before the
`lockedAccess` block and select by index. Nothing has been removed from that
track yet, so the positions still line up.

Applied to `removeHiddenClips`, `removeDisabledClips` and
`removeAdjustmentLayers`. `flattenToSingleTrack` uses the same idea differently:
it re-fetches the track each pass and always takes the **first remaining** clip,
which works because each original is removed once its copy has landed — with a
guard so a clip that cannot be moved ends the pass instead of looping forever.

Note the exposure is per clip, not per function: `await item.isDisabled()` plus
`await item.getName()` on a 21-clip track is 42 awaits before anything is
removed. Counting awaits in the source under-reads the real risk.

This is the fifth face of the same rule — actions, handles, values, sequences,
and now track items. **If it came from an earlier `await`, assume it is dead.**

## 18. Auto-starting the export: not through AME's queue

`EncoderManager` exposes methods absent from the type definitions:

```
startBatchEncode, launchEncoder, setSidecarXMPEnabled,
setEmbeddedXMPEnabled, subscribeToEvent
```

`startBatchEncode()` looks like the answer and is not. It returns `true`
**even with an empty queue**, so its return value proves nothing, and a job
queued with `EXPORT_QUEUE_TO_AME` sat unrendered with AME idle at 1% CPU after
calling it. The name suggests it drives `EXPORT_QUEUE_TO_APP`
(`com.adobe.mezzanine.export.queue.batch`) — but queueing to APP **returns
false**, refusing the job outright. So Premiere cannot start Media Encoder's
queue.

**`EXPORT_IMMEDIATELY` does start on its own.** It renders inside Premiere, no
queue and no Start button. Verified end to end: an immediate export produced a
complete, valid file — H.264, 1920x1080, 25fps, **63.20s**, matching the source
exactly, with nobody touching anything. The cost is that Premiere is busy until
it finishes.

Note the output filename gains its extension from the preset, and a temp file
(`NAME.73431.9941337.m4v`) exists during the render and is renamed on
completion — so watching for the final name is the way to detect the end, not
watching for any file.

`launchEncoder()` does work, and is worth calling on the queue route so AME
comes up showing the job rather than holding it invisibly.

## 19. Mapping AAFExportOptions onto Premiere's own dialog

The panel's AAF settings mirror Premiere's AAF Export Settings dialog, control
for control and in the same order, so the two can be read side by side. The
mapping:

| Premiere's dialog | `AAFExportOptions` |
| --- | --- |
| Mixdown video | `setMixdownVideo` |
| Breakout to Mono ▸ Enable | `setExplodeToMono` |
| Render audio clip effects | `setRenderAudioEffects` |
| Include clip copies without effects | `setInterleaveWithoutEffects` |
| Sample Rate | `setSampleRate` |
| Bits per Sample | `setBitsPerSample` |
| Files: Separate / Embedded Audio | `setEmbedAudio` |
| Preserve media directory name | `setPreserveParentFolder` |
| Format: Broadcast Wave / AIFF | `setAudioFileFormat` (WAV `1`, AIFF `0`) |
| Render: Trim / Copy Complete Audio Files | `setTrimSources` |
| Handle Frames | `setHandleFrames` |

**"Use tape sources when present" has no API property.** The panel omits it
rather than showing a control that does nothing.

All eleven were verified by setting every one away from its default and reading
them back off the exporter: 96000 / 32-bit / trim / 25 handle frames / preserve
directory / interleave — every value came back as set. The export then wrote a
211 KB AAF plus an **`AAF Media` folder of 18 trimmed audio files**, against
1 MB for the same sequence untrimmed, confirming the settings reach the file and
not just the options object.

`Handle Frames` only applies when Render is Trim Audio Files; the panel disables
it otherwise, exactly as Premiere greys it.

**"Render and Replace" now lives in one place.** It was a third option on the
Mix effects radio *and* the AAF's "Render audio clip effects" — the same thing
twice. The radio is now Keep / Remove, covering only what happens to the mix
timeline, and rendering is the AAF setting, which is where Premiere puts it.

## 20. Conformer: the import and placement primitive, established by trial

Onliner never imports media or puts it on a track, so nothing above covers the
primitive the Conformer needs for all three modes. Enumerated on 26.3.2
(prototype-chain `getOwnPropertyNames`), then **established by real placements
on a scratch sequence** in a throwaway copy of a real project, using that job's
own DaVinci exports. Every artefact was removed afterwards.

### The answer: marks on the project item, then overwrite

There is no placement call that takes a source range. The route that works:

```js
// 1. mark the range on the imported clip
clip.createSetInOutPointsAction(TickTime in, TickTime out)
// 2. place it - the overwrite reads those marks
editor.createOverwriteItemAction(projectItem, atTime, videoTrackIndex, audioTrackIndex)
```

**Verified**: one imported graded file, two different ranges, placed one after
the other. Asked 1.0–2.0s at 400s and 4.0–5.5s at 420s; landed `srcIn` 0.959
dur 1.001, and `srcIn` 3.962 dur 1.502. So the same file serving two cuts works
by re-marking between placements — the AMBIGUOUS / "one export, two cuts" case
in SKILL.md. Marks are shared bin state, so this is sequential by nature: mark,
place, re-mark, place. `createClearInOutPointsAction()` works and resets to the
whole clip.

**The offsets above are frame snapping, not error.** The scratch sequence was
23.976 (timebase 10594584000 ticks/frame) and the media 25 — placement snaps to
the *sequence* grid, so a request in seconds can land a frame out. **Work in
ticks or `TickTime.createWithFrameAndFrameRate`, never seconds.**

### Out-of-range marks do not fail — they place garbage

The first test file was a 6-frame, 0.32s 8K ProRes export. Marked 2–4s — well
past its end — it placed a **2.002s clip** with no error anywhere. The mark
read-back was the tell: the in point came back clamped to `0.24` while the out
stayed `4`. In range, read-back is exact (asked 1.0/2.0, read 1.0/2.0).

**So: validate `sourceIn + duration` against the real media duration before
placing** (the plan's own handle arithmetic, or ffprobe), and treat a read-back
that differs from what was written as out of range. A silently wrong 2 seconds
of nothing is exactly the failure this tool must not produce.

`Media.start` / `Media.duration` are **not** usable for that check: both exist
and return objects, but their `seconds` and `ticks` are `undefined`. Read the
duration from a placed track item, or from outside Premiere.

### Import

`Project.importFiles([path], suppressUI, targetBin, asNumberedStills)` returns
a plain `true` — no items.

- **A second import of the same path makes a DUPLICATE project item.** Two
  identical items, same path, same bin. Dedupe before importing, or re-running
  a conform silently doubles the bin.
- **`findItemsMatchingMediaPath` did not find the newly imported items.** Called
  with the exact on-disk path it returned only the pre-existing item, both
  before and after the import. Locate imports by **diffing the target bin's
  items before and after** instead.
- **Paths do not compare literally.** Items already in the project report
  `///Volumes/…` (triple slash); freshly imported ones report `/Volumes/…`.
  Normalise leading slashes before matching, or nothing matches itself.

### Video only: no flag, remove the audio afterwards

`audioTrackIndex: -1` does **not** suppress audio — it landed on A1 regardless.
The fallback works and is verified: place, then
`createRemoveItemsAction(selection, false, MediaType.AUDIO, false)` — audio
gone, video untouched. Ripple stays false, as everywhere else here.

### The undeclared methods, and why they change nothing

`SequenceEditor.createAddItemAction` / `createAddItemsAction` and
`ClipProjectItem.createSubClipAction` are absent from the type defs but real
(so are `SourceMonitor.setPosition`, track `createSetNameAction` /
`subscribeToEvent`, and `ProjectItem.TYPE_COMPOUND` / `TYPE_FILE` / `TYPE_STYLE`).

```js
createAddItemAction(projectItem, time, videoTrackIndex, audioTrackIndex,
                    isInsert, ?, ?)   // exactly 7 args; last three bool/number
```

Fewer than seven throws "Not Enough Parameters"; a `TickTime` in positions 5–7
throws "Illegal Parameter type" — **there is no source-range argument here
either**. Executed against a collision, argument 5 is `isInsert`: `true` ripples
the overlapped remainder later, `false` is identical to the declared overwrite.
Arguments 6 and 7 showed no observable effect; pass `false`.

`createAddItemsAction` rejects an array as its first argument and there is no
`ProjectItemSelection.createEmptySelection` to build the collection it presumably
wants. Unresolved — and unnecessary, since the declared overwrite does the job.

`createSubClipAction(name, inPoint, outPoint, boolean)` accepts exactly four
arguments (three throws, five throws). Not executed. It is the alternative if
shared marks ever prove fragile, at the cost of a subclip per cut.

## 21. Conformer: whole-file modes — sequence span, audio placement, tracks

Established by trial 2026-09-24 against Premiere 26.3.2, for the single-master
and audio-stem modes. Everything below was run on a throwaway clone.

**`Sequence.getZeroPoint()` is the sequence's start timecode**, and it is the
piece that makes these modes safe. Measured on a real offline it returns
`3600s` — 01:00:00:00. A master rendered from that sequence carries the same
start TC, so `sourceIn = seqZero − fileStartTC` is exact and assumes nothing
about how the render was set up. Without it the only evidence left is "the
lengths match", and a file with head handles has no way to declare itself.

Alongside it: `getEndTime()` is the duration (85.04s on that job), `getInPoint`
/ `getOutPoint` bracket it, and `getSettings()` / `getFrameSize()` both return
`{}` through this bridge — use `getFrameSize()` via the panel, which does work
there, or read dimensions from the media.

**Audio-only placement uses the SAME mark-then-overwrite primitive.** A WAV cast
to `ClipProjectItem`, marked `0 → 85.04` with `createSetInOutPointsAction`, then
`createOverwriteItemAction(item, 0, videoTrackIndex, audioTrackIndex)`, landed on
exactly the requested audio track, created that track, and did **not** create a
video track — the `videoTrackIndex` argument is simply ignored for an item with
no picture. A video-only ProRes behaves as the mirror image: lands on the
requested video track, creates no audio track. Neither changed the sequence's
own duration.

**An unmarked project item reports in/out as `-400000` seconds**, not null and
not zero. The multi-clip path never sees this because it always marks first.
Anything that reads marks before setting them has to treat that as "unmarked"
rather than as a time.

**`MediaType.ANY` exists as a constant and throws `Illegal Parameter type`** when
passed to `getInPoint`/`getOutPoint`. Use `VIDEO` or `AUDIO`.

**`Track` exposes `setMute(bool)` and `createSetNameAction(name, true)`**, both
of which matter for stems: the offline's own audio has to be muted or the stems
play on top of the scratch mix rather than instead of it, and four tracks called
"Audio 4…7" defeat the entire point of delivering stems separately. `isMuted()`,
`getIndex()` and a `name` property ("Audio 1") are there too.

**`Project.deleteSequence(seq)` returns `true` without deleting** when that
sequence is open in the timeline. Close it first — `closeSequence(seq)` — and
the same call then works. Only a testing concern, but it silently reports
success, which is the worst way to be wrong.

## Open question for the next phase

Time Remapping cannot be detected (point 4), so the panel cannot list *which*
clips need manual attention — only warn that it cannot tell. Three options,
cheapest first:

1. Warn once per run: "speed changes cannot be detected; check any ramped
   clips by hand."
2. Detect the *symptom* instead — compare each clip's source duration against
   its timeline duration. A clip whose ratio is not 1:1 has been retimed. This
   catches constant speed changes and would miss a ramp that nets out to the
   same length.
3. Read the source `.prproj` (it is gzipped XML) and look for time-remap
   keyframes directly, outside the API.

Option 2 gives a real per-clip list for the common case at little cost. It is
worth confirming against a ramped clip before committing to it.

## 20. Windows: what Premiere 26.5.2 on Windows 11 ARM64 actually did

Measured 2026-10-06 in a Parallels VM - Premiere 26.5.2 and
Media Encoder 2026 installed, native ARM64 build (Adobe shipped Windows-on-ARM
in 26.0). Both panels were driven for real: project created, clip imported,
sequence built, the Onliner's grade and reference runs executed, the
Conformer's helper installed as a Scheduled Task and heartbeating.

**`require()` resolves differently for nested modules.** `js/app.js`, loaded
by `index.html`, resolves against the plugin root (§8), so it must ask for
`./js/prefs`. But a module that app.js required - `js/presets.js` - resolves
against ITS OWN folder: `require("./js/platform")` from inside `js/` fails
with `Module not found: "./js/platform". Parent module folder was: "/js"`,
and the panel is dead at load with no visible error, exactly as §8 describes.
`requireSibling()` in presets.js, fcpxml.js and ppro.js tries `./x` then
`./js/x`. Whether the Mac build does the same for nested modules is untested;
the helper makes it not matter.

**The plugin registry entry needs backslashes after the token.** The Mac entry
`"path": "$localPlugins/External/theonliner_1.0.0"` is read, logged as
`plugin with id: theonliner is added ... with status as enabled`, and then
`failed to create/initialize plugin at ` (empty path) - silently, panel
absent, `Number of plugins added from user's pluginsInfo: 0`. The same with an
absolute backslash path. `$localPlugins\External\theonliner_1.0.0` initialises.
(With NO registry file at all, this build falls back to scanning
`%APPDATA%\Adobe\UXP\Plugins\External` and loads whatever is there, junctions
included - but a registry that exists for any other plugin switches that
scan off, so the installer writes the entry.) Registry location confirmed
from Premiere's own log: `%APPDATA%\Adobe\UXP\PluginsInfo\v1\premierepro.json`.
Directory junctions are followed.

**Plugin data lands where the Mac's does**:
`%APPDATA%\Adobe\UXP\PluginsStorage\PPRO\26\External\<id>\PluginData`. The
`%APPDATA%\Adobe\Premiere Pro\26.0\UXP\PluginsStorage` tree that also exists
holds only Adobe's Internal plugins.

**`getEntryWithUrl` takes `file:/C:/Users/...`** - the Mac form with the
slashes turned round, as Adobe's own recipe prints it. `os.platform()` reports
a `win...` string and `os.homedir()` returns `C:\Users\<name>`. Both AME preset
roots resolved: 538 presets found, 537 under
`C:\Program Files\Adobe\Adobe Media Encoder 2026\MediaIO\systempresets`, one
planted under `Documents\Adobe\Adobe Media Encoder\26.0\Presets`.

**`project.path` comes back extended-length**: `\\?\C:\Users\...\x.prproj`.
Anything that normalises or displays paths has to strip `\\?\` (and
`\\?\UNC\` to `\\`) first, or a local drive reads as a UNC share.

**`exportAsFinalCutProXML` and the picked-folder readback both took a
backslash path.** Export to `C:\...\VMTest\X_FOR_GRADE.xml`, re-open by name
through the folder entry the picker granted, 1/1 clipitems, 8 empty tracks
stripped in place, file well-formed, media as
`file://localhost/C%3a/Users/...`.

**Rendering now with no preset is impossible on this build.**
`exportSequence(seq, EXPORT_IMMEDIATELY, out, undefined, true)` throws
`Illegal Parameter type`; leaving the preset argument out throws
`Invalid parameter.`; an empty string likewise. With a real `.epr` path the
five-argument call renders - a 111 MB ProRes 422 HQ reference, burn-in on a
nest, in a GPU-less VM. The panel now says to pick a preset instead of
reporting the raw error.

**Preset names with parentheses were shown raw** -
`($$$/AME/EncoderHost/Presets/<guid>/PresetName=Match Source (Rewrap))` -
because `parsePresetName` matched up to the first `)`. The Mac
systempresets carry the same names, so this was never Windows-specific.

**UXP's `<select>` ignores clicks delivered into its popup window** from
synthetic mouse input (SendInput). Keyboard selection - open, arrow, Enter -
works. A test-harness note, not a panel bug.

**The helper as a Scheduled Task works end to end**: `pythonw.exe` under
`py -3`, `--log` to `%LOCALAPPDATA%\TheConformer\helper.log`, found the queue
the panel created and heartbeat within seconds of the panel opening.

## 22. Premiere 2025 (25.6.6): no FCPXML or AAF in UXP, and the CEP bridge that fills the gap

Back-compat run on 2026-10-07, Premiere 25.6.6 build 5 on macOS, against a
local copy of a real project (a 64-second 9x16 social cut: 18 video clips on
5 tracks, 25 audio, 2 disabled, 2 adjustment layers).

**Everything that builds a timeline works unchanged on 25.6.6.** Clone,
disabled/adjustment/hidden removal, the overwrite-clone flatten, Motion reset,
audio strip, the reference nest and the timecode burn-in all produced exactly
the predicted result, clip for clip: 13 clips on V1 with the right top-layer
shots kept, 24 mix clips with the disabled music cue gone.

**`ProjectConverter` does not exist in 25.6.6's UXP.** The capability probe
read `FCPXML ✗ · AAF ✗` and gated both exports off - correctly, so the run
completed, but a 2025 user got no XML and no AAF.

**ExtendScript on the same build exports both.** `seq.exportAsFinalCutProXML(path, 1)`
wrote a 13-clipitem XML; `app.project.exportAAF(...)` wrote an AAF. A UXP panel
cannot call ExtendScript, so `cep-bridge/` is a headless CEP extension
(`theonliner.cepbridge`) that does it for the panel:

- Talks through `cep-queue/` inside the panel's own UXP data folder - the
  Conformer's request/response/heartbeat protocol, no network, no prompt. The
  folder is per Premiere MAJOR (`PluginsStorage/PPRO/25/...`), so a 2025 and a
  2026 open together never answer each other.
- Starts with Premiere (`Lifecycle`: `AutoVisible` false, `StartOn`
  `com.adobe.csxs.events.ApplicationActivate`, `UI Type` Custom). **Verified:
  on 25.6.6 it started on its own at launch** and heartbeat within a second;
  nobody opens anything.
- The panel uses it only where the UXP export is missing, decided live at the
  point of export (`nativeExport()` in ppro.js). Its manifest host range is
  `[25.6,25.9]`, so 26.x does not load it at all.
- **UXP's `sequence.guid` and ExtendScript's `sequenceID` are the same
  string** - every request matched by ID. The exact-name fallback is there for
  safety and refuses an ambiguous name rather than guess.
- Verified through the real panel: FCPXML via CEP, 13/13 clipitems verified by
  the panel's own count, 25 empty tracks then stripped from it, valid XML; AAF
  via CEP. Malformed and unknown requests (an `eval` kind, half-written JSON)
  are refused without running anything.

**ExtendScript's `exportAAF` only writes new audio when Breakout to Mono is
on.** Measured, same mix timeline, 14-argument form, every flag 1/0:

| Breakout to Mono | Other flags | Result |
|---|---|---|
| off | defaults | 771,072-byte AAF linking the original MXFs, no media written |
| off | Trim + 25 handles | byte-identical size - trim did nothing |
| off | Embedded | byte-identical size - nothing embedded |
| off | Render audio clip effects | byte-identical size |
| on | 96 kHz / 16-bit, Embedded | 424 MB AAF, audio embedded, mono 96k/16 |
| on | Separate, Copy Complete | 24 mono WAVs, 2,188 s of audio, 309 MB |
| on | Separate, Trim + 25 handles | 26 mono WAVs, **175 s**, 25 MB - trim honoured |

The 26.x UXP exporter renders trimmed stereo WAVs with Breakout off, so this is
a real 25.x difference. The bridge does not quietly force mono - that changes
the deliverable - it reports it: `cepbridge.ignoredAafOptions()` names the
options 25.x will not act on, and the Mix card says so in plain words, and
stops claiming effects were "baked into the AAF media" when they were not.

Untested on 25.x: Mixdown video, "Include clip copies without effects" and
"Preserve media directory name" through ExtendScript. Passed through as asked.

Two smaller things from the same run, neither 25.x-specific:

- **"Sequence's own export settings" + Render now** rendered an MPEG-2
  612x1088 `.mpg` (the sequence's preview format) on 25.6.6, where 26.5.2 on
  Windows refused outright. With a real preset (FULLRES_H264) the same run gave
  a 1080x1920 H.264 MP4.
- **The timecode burn-in clips its last digit on a 9x16 sequence** - the line
  is laid out for 16:9. Seen with both the MPEG-2 and the H.264 reference.

Windows: verified the same day - see §24.

## 23. The timecode burn-in is a fixed pixel size; its position is a fraction

On a 9x16 reference the burn-in lost its last digit off the right edge. Measured
on Premiere 25.6.6 by rendering the effect (through `exportAsMediaDirect` with a
real preset - QE's `exportFramePNG` renders the effect differently and must not
be used to measure it) on nests of three shapes:

| Frame | Size | Box (w x h) | Left edge |
|---|---|---|---|
| 1080x1920 | 25 | 708 x 95 px | 0.381 - 40 px past the right edge |
| 1920x1080 | 25 | 708 x 95 px | 0.380 |
| 3840x2160 | 25 | 707 x 95 px | 0.380 |
| 1080x1920 | 8.44 | 237 x 31 px | 0.381 |

**The text is a fixed pixel size** - about 28.4 px of box width per unit of the
effect-wide Size, on every frame - while **Line 1's Position is a fraction of
the frame, measured to the box's left edge**. Adobe's default x of 0.38 only
looks central on a 1920-wide frame. (Also: a burn-in is a CLIP effect, so it
renders in the nested clip's frame - changing the reference sequence's frame
size moves it off-screen rather than resizing it.)

`js/burnin.js` lays Line 1 out for the reference's actual width from
`sequence.getFrameSize()`: centred, and Size reduced only when even a centred
box would not fit within 5% margins. Checked by rendering the computed positions:
1080x1920 -> box at 185-893 px, 1920x1080 -> 605-1313 px, both centred and
whole. A build without `getFrameSize` keeps Adobe's position. Position is a
point param, so it is written as a `PointF` built inside `lockedAccess`.

Also seen once and not explained: a reference the panel had just rendered with
Size 25 later read back Size 8.4375 through ExtendScript (25 x 0.3375). The
panel's render was correct; something after it changed the stored value. Not
reproduced.

## 24. Windows: the CEP bridge and the burn-in layout, on 25.6.6 and 26.5.2

Run 2026-10-07 in the Parallels Windows 11 ARM64 VM, Premiere 25.6.6 and 26.5.2
installed side by side, on a 9x16 test sequence built for a known outcome (V1
two clips, V2 hiding the second, V3 disabled; a disabled audio clip).

**Installer.** `install-dev.ps1`'s new step ran clean on its first real run: a
junction `%APPDATA%\Adobe\CEP\extensions\theonliner.cepbridge` ->
`cep-bridge`, PlayerDebugMode "1" for CSXS 9-13, the UXP registry keeping the
other plugin's entry. **CEP follows the junction.**

**Premiere 25.6.6 on Windows.** The bridge started with Premiere on its own,
found its queue at `%APPDATA%\Adobe\UXP\PluginsStorage\PPRO\25\External\theonliner\PluginData\cep-queue`,
and the status line read `FCPXML ✓ via CEP · AAF ✓ via CEP`. Through the panel:

- FCPXML via CEP to a `C:\...` path, 2/2 clipitems, 8 empty tracks stripped,
  media referenced as `file://localhost/C%3a/...`;
- AAF via CEP with Breakout to Mono ON: 6 mono 48 kHz/24-bit WAVs in `AAF Media`;
- AAF via CEP with it OFF: a reference AAF, and the Mix card's warning naming
  Trim and Render audio clip effects as not applied - same as on the Mac;
- grade 1 hidden + 1 disabled removed, flattened to 2 clips; mix 3 of 4 audio
  clips (the disabled one removed).

**Premiere 26.5.2 on Windows.** The bridge did NOT load (no CEP process for
it, no `PPRO\26` queue folder) - its `[25.6,25.9]` host range holds. Status
line `FCPXML ✓ · AAF ✓`; the same run exported both `via=uxp`.

**Burn-in.** On both versions the panel logged `frameWidth=1080 size=25
x=0.1713`, and the rendered references put the timecode glyphs at x 197-883 on
a 1080-wide frame - centre 540.0 exactly, nothing cut off. `getFrameSize()`
works on 25.6.6 and 26.5.2.

Driving notes (not panel bugs): a UXP `<select>` moves one option per arrow key
once it has focus, type-ahead does nothing, and the preset list is only built
when the panel starts, so a preset added to the user folder needs a Premiere
restart. A floating panel window can sit partly off-screen with its footer
hidden - dock it.
