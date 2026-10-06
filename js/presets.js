/**
 * presets.js - find the Media Encoder .epr presets on this machine.
 *
 * The panel needs a preset to export a reference with. AME's own presets live
 * inside the application install, the facility's house presets live in the
 * user's Documents - FULLRES_H264.epr and friends. Both are offered.
 *
 * Neither folder is one the editor picked, so these are the panel's only
 * reaches to a path by name - through `platform.openEntry`, which needs
 * `localFileSystem: "fullAccess"` in the manifest. There is no Node `fs` here
 * (require("fs") returns only a URL helper), so this is the only route. A
 * folder that is absent, or that the host refuses, is simply not offered.
 */

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

const platform = requireSibling("platform");

// Year-numbered releases, newest first. The house presets sit under the
// current one; older installs are searched so a machine mid-upgrade still
// finds something.
const AME_YEARS = ["2026", "2025"];
const AME_USER_VERSIONS = ["26.0", "25.0", "24.0", "23.0"];

/**
 * AME's own presets: <app root>/MediaIO/systempresets on both platforms, with
 * the app root differing - see platform.adobeAppRoot.
 */
function appPresetDirs(which) {
  return AME_YEARS.map((year) =>
    platform.joinPath(platform.adobeAppRoot("Adobe Media Encoder", year, which),
                      "MediaIO", "systempresets"));
}

/**
 * The editor's own presets: Documents/Adobe/Adobe Media Encoder/<ver>/Presets
 * under the home folder on both platforms - Adobe's "Reveal Preset File"
 * lands there on Windows and on a Mac alike. Empty when home is unknown.
 */
function userPresetDirs(home) {
  const h = home === undefined ? platform.homeDir() : home;
  if (!h) return [];
  return AME_USER_VERSIONS.map((v) =>
    platform.joinPath(h, "Documents", "Adobe", "Adobe Media Encoder", v, "Presets"));
}

/**
 * Where the panel is going to look, for the preset note. `home` null means
 * the host gave no home folder, so the house presets cannot be searched for
 * - survivable, but the editor should see why their presets are missing
 * rather than assume the panel is broken.
 */
function presetSources() {
  const home = platform.homeDir();
  return {
    platform: platform.platform(),
    home,
    userDirs: userPresetDirs(home),
    appDirs: appPresetDirs()
  };
}

/**
 * Adobe wraps preset display names in its localisation syntax:
 *   <PresetName>($$$/AME/.../PresetName=Apple ProRes 422 HQ)</PresetName>
 * Unwrap it when present, otherwise use whatever is between the tags, and fall
 * back to the filename. Same parsing as The Consolidator's transcode.js.
 */
function parsePresetName(xml, fallback) {
  const m = /<PresetName>([\s\S]*?)<\/PresetName>/.exec(xml || "");
  if (m) {
    const raw = m[1].trim();
    // Greedy up to the LAST ")": the name itself often holds parentheses -
    // "Match Source (Rewrap)", "HD 1080i 25 (1.33 PAR)" - and a non-greedy
    // match stopped at the first one, so those fell through to the raw
    // "($$$/AME/EncoderHost/Presets/<guid>/PresetName=...)" string. Seen on
    // Windows, but the Mac systempresets carry the same names.
    const loc = /=(.*)\)\s*$/.exec(raw);
    const name = loc ? loc[1].trim() : raw;
    if (name) return name;
  }
  return fallback;
}

async function readPresetName(entry) {
  const fallback = entry.name.replace(/\.epr$/i, "");
  try {
    // Preset XML is small; the name is near the top.
    const text = await entry.read();
    return parsePresetName(String(text).slice(0, 4000), fallback);
  } catch (e) {
    return fallback;
  }
}

/**
 * Every .epr worth offering, newest-first by source, de-duplicated by path.
 * `systempresets` nests one level (folders named <hostFourCC>_<formatFourCC>
 * in hex), so it is walked one level down; user preset folders are flat.
 */
async function findPresets() {
  const found = [];
  const seen = Object.create(null);

  const collect = async (entry, source) => {
    if (!entry || !entry.isFolder) return;
    let kids;
    try {
      kids = await entry.getEntries();
    } catch (e) {
      return;
    }
    for (const kid of kids) {
      if (kid.isFolder) continue;
      if (!/\.epr$/i.test(kid.name)) continue;
      const path = kid.nativePath || kid.name;
      if (seen[path]) continue;
      seen[path] = true;
      found.push({ path, source, name: await readPresetName(kid) });
    }
  };

  for (const dir of userPresetDirs()) {
    await collect(await platform.openEntry(dir), "user");
  }

  for (const dir of appPresetDirs()) {
    const root = await platform.openEntry(dir);
    if (!root || !root.isFolder) continue;
    let groups;
    try {
      groups = await root.getEntries();
    } catch (e) {
      continue;
    }
    for (const group of groups) {
      if (group.isFolder) await collect(group, "system");
    }
  }

  // House presets first - they are what these jobs actually deliver on - then
  // alphabetical within each source.
  found.sort((a, b) => {
    if (a.source !== b.source) return a.source === "user" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return found;
}

module.exports = { findPresets, parsePresetName, presetSources, appPresetDirs, userPresetDirs };
