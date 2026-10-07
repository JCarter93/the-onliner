# The Onliner

A Premiere Pro panel. Takes a locked offline sequence and produces a
burned-in timecode reference, a clean grade-ready picture timeline, and a clean
mix-ready audio timeline — each independently toggleable, each auto-exporting
the handoff the next department needs (FCPXML for grade, AAF for mix).

One of three panels from the same team, with **The Conformer** (graded footage
back onto the offline) and **The Consolidator** (project archiving) — same house
style, same report formatting. This one and The Conformer are **UXP**; The
Consolidator is CEP.

Plugin id `theonliner`. Built on a Mac; runs on Windows too — verified on
Premiere 26.5.2 (Windows 11 ARM64), see "Windows" below. MIT licence, see
`LICENSE`.

## Install (dev)

```bash
./scripts/install-dev.sh
```

Symlinks this folder into `~/Library/Application Support/Adobe/UXP/Plugins/External/`
as `theonliner_1.0.0`, matching `manifest.json`, **and registers it** in
`~/Library/Application Support/Adobe/UXP/PluginsInfo/v1/premierepro.json` —
Premiere does not scan the plugins folder, and an unregistered plugin is
ignored silently. Restart Premiere, then find the panel in the plugins menu. If
the UXP loader refuses to follow the symlink, `./scripts/install-dev.sh copy`
does a real copy instead — re-run it after every edit.

`./scripts/uninstall-dev.sh` removes it.

On Windows:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-dev.ps1
```

Same two steps against `%APPDATA%\Adobe\UXP\Plugins\External` and
`%APPDATA%\Adobe\UXP\PluginsInfo\v1\premierepro.json`, using a directory
junction (no admin, no Developer Mode). `scripts\uninstall-dev.ps1` removes it.

## Windows

The panel never spells out a platform path. Everything it writes goes into a
folder the editor picked, through the entry UXP handed back, and the one
module that has to know the OS is `js/platform.js`:

- `joinPath` keeps whichever separator the picked folder already uses, so a
  Windows destination stays `C:\...\MyEdit_FOR_GRADE.xml` for Premiere's
  exporter.
- `openEntry` is the only `getEntryWithUrl` call, for the Media Encoder preset
  folders nobody picks. It tries `file:/C:/Users/...` (the form Adobe's own
  Premiere UXP recipe prints for Windows, beside `file:/Users/...` for Mac),
  then the bare native path. On Windows the URL form is the one that works.
- `adobeAppRoot` holds the two AME install roots side by side.
- `stripExtendedPrefix` drops the `\\?\` Premiere puts on `project.path` there.

`tests/portability-test.js` fails the build if a literal `/Applications`,
`/Users/`, `~/Library`, `.app/Contents` or a hand-built `"file:" + path` turns
up anywhere else, so this cannot rot back out unnoticed.

**Verified on a Windows machine (Premiere 26.5.2, Windows 11 ARM64, Parallels,
2026-10-06).** The panel loads through the junction and the registry entry;
538 presets found across both AME roots; a grade run wrote and verified an
FCPXML at a backslash path and stripped its empty tracks; a reference run with
a preset rendered an 8-second ProRes with the burn-in. Two things only that
machine could teach: a `require()` from inside `js/` resolves against `js/`,
not the plugin root (hence `requireSibling`), and the registry path must be
`$localPlugins\External\<id>` with backslashes. Both are in
`docs/API-FINDINGS.md` §20. Not exercised there: the AAF export and the
queue-to-AME route, which use the same path shape as the two that were.

## Premiere 2025

Premiere 25.x has no FCPXML or AAF export in its UXP API, so on 2025 those two
exports go through **The Onliner CEP Bridge** (`cep-bridge/`) - a headless CEP
extension that runs them through ExtendScript for the panel. The dev installer
puts it in place beside the panel (`~/Library/Application Support/Adobe/CEP/extensions/theonliner.cepbridge`,
or `%APPDATA%\Adobe\CEP\extensions\...` on Windows) and turns on CEP's
PlayerDebugMode. It starts with Premiere; there is nothing to open. The status
line reads `FCPXML ✓ via CEP · AAF ✓ via CEP` when it is in use, and the report
marks each export that went through it. Its manifest limits it to Premiere
25.x: on 26.x the panel exports natively and the bridge does not even load.

One behaviour differs on 2025: its AAF exporter only writes new audio files
when **Breakout to Mono** is on. With it off the AAF links the original media,
and Trim, Embedded and Render audio clip effects do nothing - the Mix card
says so when it happens. Verified on Premiere 25.6.6 on macOS and on Windows 11
(where `install-dev.ps1` installs the bridge through a junction), and confirmed
NOT loading on 26.5.2. Details: `docs/API-FINDINGS.md` §22 and §24.

## Tests

```bash
./scripts/run-tests.sh
```

The pure-logic tests run under JavaScriptCore (`jsc`), so they need no Node. Only logic that does not touch the Premiere API is
covered this way — naming, collision versioning, file-stem sanitising. Anything
that talks to Premiere is tested in the app, per the phase test plans in the
build spec.

## Layout

| Path | What it is |
| --- | --- |
| `manifest.json` | UXP plugin manifest. `minVersion` 25.6.0. |
| `index.html` | Panel markup. Loads `js/app.js` only; that pulls the rest in with `require()`. |
| `css/style.css` | House style, shared visual language with The Consolidator. |
| `js/app.js` | UI state, reveal/disable behaviour, previews, report. Never touches the Premiere API. |
| `js/ppro.js` | **The only module that imports `premierepro`.** |
| `js/naming.js` | Suffix, collision versioning, file-stem sanitising. Pure, tested. |
| `js/prefs.js` | Last-used settings. |
| `js/platform.js` | The only module allowed to name a platform root: path joins, file URLs, the AME install roots. Pure, tested. |
| `js/presets.js` | Finds the Media Encoder `.epr` presets, house ones first. |
| `js/fcpxml.js` | Strips empty tracks from the exported XML and reads Premiere's translation report. Pure where it can be, tested. |
| `js/cepbridge.js` | The panel's side of the CEP bridge: queue, heartbeat-based waiting, which AAF options 25.x ignores. Pure parts tested. |
| `cep-bridge/` | **The Onliner CEP Bridge** - headless CEP extension that runs the FCPXML/AAF exports through ExtendScript on Premiere 25.x. `js/queue.js` is the protocol (pure, tested), `js/main.js` the I/O loop, `host/exports.jsx` the ExtendScript (tested in jsc against a fake `app`). |
| `tests/portability-test.js` | Static guard: no Mac path may appear in panel code. |
| `docs/API-FINDINGS.md` | What the runtime actually exposes, where it differs from the docs and from the spec. Read this before the next phase. |

## Status — all four phases built and run against real footage

Verified end to end on a real 60-second teaser (49 clips, 25 of them multicam):
a reference MP4 whose burned-in timecode reads `00:00:10:00` at ten seconds, a
single-track grade timeline with a complete 29-of-29 FCPXML, and an AAF with its
audio media. See below for what each phase does.

## Detail

**Phase 1 (panel shell and toggle state) — built and tested.** 140 tests pass
(`./scripts/run-tests.sh`); the toggle matrix and persistence are driven
against the real `app.js` through a mock DOM, since the panel cannot be clicked
from outside Premiere.

**Phase 2 (reference export with timecode) — done and confirmed on a real
sequence.** Run end-to-end through the panel against an earlier cut of the
same teaser: the reference sequence is a
single-track-item nest of the source with the burn-in on its chain, queued to
Media Encoder. Both spec criteria met — a rendered frame reads `00:00:02:00` at
two seconds (sequence timecode, exact), and the no-timecode path exports
cleanly with the effect skipped. A second run produced `_REF_v02`, so collision
versioning is proven live too.

**Phase 3 (grade timeline) — code complete, engine pre-flighted against a real
sequence, not yet run through the panel.** Duplicates the locked sequence,
empties the audio, resets Motion, strips the temp grade, files the result in
`FOR_GRADE` with a violet label and a run-manifest marker, and exports FCPXML.

It stops at a **multicam gate**: multicam clips do not survive FCP7 XML export,
and cannot be flattened from the API (Premiere does not expose which angle a cut
uses), so the run pauses before writing the XML, names the offending clips, and
waits for the editor to flatten them on the new grade sequence. Continue
re-scans rather than trusting, and re-counts the clips before verifying the
export. "Skip the FCPXML" abandons the export but keeps the prepared sequence.

Grade also removes **adjustment layers** (they carry the temp grade), **clips
hidden by a layer above** (invisible in the programme, but they still conform),
and optionally **flattens everything onto V1** with the top layer winning. All
three are checkboxes; flatten is off by default because it is destructive to
real composites.

Graphics are removed **by hand** before running — the panel does not try to
identify them, and the flatten report lists every clip it moved so a graphic
that won over a shot is easy to spot.

Two safety rules learned the hard way and enforced in code:

- Flatten refuses to run while an adjustment layer is present. A full-length
  LUT layer flattened down overwrote every shot: **37 clips became 3.** The
  combination is blocked before the run and again inside the engine.
- Only fully-covered clips are removed. Partly-covered ones are kept and listed,
  because trimming them to the visible part would change the edit. Alpha cannot
  be detected, so the covering clip is always named in the report.

After every FCPXML export the panel reads Premiere's own **"FCP Translation
Results"** report — which nothing otherwise surfaces — and lists what the export
could not carry. That is how Warp Stabilizer turned out to be silently dropped
from FCP7 XML.

The exported XML is also post-processed to **strip empty tracks** (`js/fcpxml.js`),
since Premiere cannot delete a track: the teaser went from 10 video / 30 audio
tracks to 1 / 0, with all 29 clips intact. The clip count is checked before and
after and the file is left as Premiere wrote it if anything does not match.

**Phase 4 (mix timeline) — built and run against a real sequence.** Duplicates
the locked sequence, strips it to audio, handles effects (keep / bake into the
AAF / strip), files the result in `FOR_MIX` with a cerulean label and a run
manifest, and exports AAF.

"Render and Replace" is `AAFExportOptions.renderAudioEffects` rather than the
export-and-reimport subsystem the spec planned — it bakes effects into the media
the AAF writes, reaching the same place with far less to go wrong.

Mix also removes **disabled clips** from the audio tracks — the teaser had 25,
muted in the edit but still travelling in the AAF.

Levels are never stripped: `Internal Volume` / `Channel Volume` / `Pan` are
fixed components carrying the edit's levels, not effects. A real run kept all
137 of them across 134 clips.

Two corrections to the build spec came out of Phase 1's API verification, both
in `docs/API-FINDINGS.md`:

- `ProjectConverter.exportAAF` and `AAFExportOptions` **do** exist at runtime
  but are **absent from the bundled type definitions**. The spec's choice of
  UXP survives, but not for the reason given — treat the runtime, not the docs,
  as the authority.
- `AAFExportOptions.renderAudioEffects` may do Phase 4's "Render and Replace"
  job without the manual export-and-reimport the spec plans. Worth testing
  first.

One deliberate departure from the build spec: outputs go into **`FOR_GRADE`**
and **`FOR_MIX`** bins, not the spec's invented `_GRADE_PREP` / `_MIX_PREP`.
Those are the bins these projects already use by hand (seen as
`1_3_MAIN_CUTS/ONLINE/FOR_GRADE`), and the panel reuses an existing bin of that
name wherever it sits in the tree rather than making a second one at the root.
The names live in `naming.BINS`.
