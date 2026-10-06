/**
 * platform.js - the few places the panel has to know which OS it is on.
 *
 * Everything else in the panel works from folder ENTRIES the editor picked,
 * which UXP hands back already correct for the platform. This module exists
 * for the leftovers: joining a filename onto a picked folder's native path
 * (Premiere's exporters want a path string, not an entry), opening a path the
 * editor never picked (the Media Encoder preset folders), and the two places a
 * path has to be found rather than chosen.
 *
 * THIS IS THE ONLY FILE ALLOWED TO NAME A PLATFORM ROOT. tests/portability-
 * test.js fails the build if "/Applications", "/Users/", "~/Library" or a
 * ".app/Contents" turns up anywhere else, and checks that every Mac root here
 * sits beside its Windows counterpart.
 *
 * Nothing here requires a host module at load time, so it runs under jsc.
 */

/**
 * "windows" | "mac" | "unknown".
 *
 * UXP's `os.platform()` reports "win32"/"win10" on Windows and "darwin" on a
 * Mac - the UXP docs list exactly those strings. The module is absent under
 * jsc and may be absent on an old host, hence the fallback, which is only
 * reached when a caller has a native path to judge by.
 */
function platform(samplePath) {
  try {
    const p = String(require("os").platform() || "").toLowerCase();
    if (p.indexOf("win") === 0) return "windows";
    if (p === "darwin" || p.indexOf("mac") === 0) return "mac";
  } catch (e) { /* no os module here */ }
  if (samplePath) return looksLikeWindowsPath(samplePath) ? "windows" : "mac";
  return "unknown";
}

function isWindows() {
  return platform() === "windows";
}

/**
 * Drop Windows' extended-length prefix. Premiere 26.5.2 on Windows reports
 * project.path as \\?\C:\..., and the same can happen to media paths; the
 * prefix means nothing to a file URL or to an editor reading a report.
 */
function stripExtendedPrefix(p) {
  const s = String(p == null ? "" : p);
  if (s.indexOf("\\\\?\\UNC\\") === 0) return "\\\\" + s.slice(8);
  if (s.indexOf("\\\\?\\") === 0) return s.slice(4);
  return s;
}

/** A drive letter or a UNC prefix is Windows; nothing else is. */
function looksLikeWindowsPath(p) {
  const s = stripExtendedPrefix(p);
  return /^[A-Za-z]:[\\/]/.test(s) || /^\\\\/.test(s);
}

/**
 * The separator a path is already using. A Windows native path from UXP has
 * backslashes; keep them, because the string is going straight back to
 * Premiere's exporter. Decided from the path itself rather than from the OS,
 * so the join is deterministic and testable without a host.
 */
function separatorOf(p) {
  const s = String(p == null ? "" : p);
  if (s.indexOf("\\") !== -1 && s.indexOf("/") === -1) return "\\";
  if (looksLikeWindowsPath(s) && s.indexOf("/") === -1) return "\\";
  return "/";
}

/**
 * dir + segment [+ segment...], one separator between each, in the dir's own
 * style. Only ever used to append filenames or folder names - it is not a
 * general path resolver and does not understand "..".
 */
function joinPath(dir) {
  let out = String(dir == null ? "" : dir);
  const sep = separatorOf(out);
  for (let i = 1; i < arguments.length; i++) {
    const seg = String(arguments[i] == null ? "" : arguments[i]).replace(/^[\\/]+/, "");
    if (!seg) continue;
    out = out.replace(/[\\/]+$/, "");
    out = out ? out + sep + seg : seg;
  }
  return out;
}

/** The folder part of a path, in the same style it came in. "" if none. */
function dirName(p) {
  const s = String(p == null ? "" : p);
  const cut = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  return cut === -1 ? "" : s.slice(0, cut);
}

/** The last segment of a path, whichever separator it uses. */
function baseName(p) {
  const s = String(p == null ? "" : p);
  const cut = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  return cut === -1 ? s : s.slice(cut + 1);
}

/**
 * A native path as the URL `getEntryWithUrl` wants.
 *
 * Adobe's own Premiere UXP recipe gives the two shapes side by side:
 *
 *     file:/Users/user/Documents          (Mac)
 *     file:/C:/Users/user/Documents       (Windows - forward slashes, drive kept)
 *
 * so the Windows form is the Mac form with the backslashes turned round. A
 * string that already carries a scheme is passed through untouched.
 */
function toFileUrl(p) {
  const s = stripExtendedPrefix(String(p == null ? "" : p).trim());
  if (!s) return s;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^[A-Za-z]:[\\/]/.test(s)) return s; // already a URL
  let body = s.replace(/\\/g, "/");
  if (!/^\//.test(body)) body = "/" + body;   // "C:/..." -> "/C:/..."
  return "file:" + body;
}

/**
 * Open an entry at a native path the editor did not pick. Tries the URL form
 * first, then the bare native path - reported to work on both platforms under
 * manifest v5 - so a host that dislikes one shape still gets the other. Null
 * when neither works: an absent folder is not an error here.
 */
async function openEntry(nativePath) {
  const fs = require("uxp").storage.localFileSystem;
  const attempts = [["url", toFileUrl(nativePath)], ["native", String(nativePath)]];
  for (const pair of attempts) {
    try {
      const entry = await fs.getEntryWithUrl(pair[1]);
      if (entry) { openEntry.lastShape = pair[0]; return entry; }
    } catch (e) { /* try the next shape */ }
  }
  return null;
}
// Which shape last succeeded ("url" | "native"), for the panel's diagnostics.
openEntry.lastShape = null;

/**
 * The user's home folder, or null. UXP's `os.homedir()` is documented on both
 * platforms, but the module can be missing on an old host, and a panel that
 * cannot find home still works - it just cannot find the house presets.
 */
function homeDir() {
  try {
    const h = require("os").homedir();
    return h ? String(h) : null;
  } catch (e) {
    return null;
  }
}

/**
 * Where an Adobe desktop app's own files live, for an app named like
 * "Adobe Media Encoder" in the year-numbered release "2026".
 *
 *   Mac      /Applications/Adobe Media Encoder 2026/Adobe Media Encoder 2026.app/Contents
 *   Windows  C:\Program Files\Adobe\Adobe Media Encoder 2026
 *
 * Both verified against Adobe's own support threads for the systempresets
 * folder, which sits at MediaIO/systempresets under each. The Windows root is
 * the installer's default; a Creative Cloud install moved to another drive
 * simply will not be found, and the panel then offers user presets only.
 */
function adobeAppRoot(appName, year, which) {
  const os = which || platform();
  const titled = appName + " " + year;
  if (os === "windows") {
    return "C:\\Program Files\\Adobe\\" + titled;
  }
  return "/Applications/" + titled + "/" + titled + ".app/Contents";
}

/**
 * A path for the eye, not for the host: the style the current platform shows
 * in its own file browser. Used in reports only.
 */
function displayPath(p) {
  const s = stripExtendedPrefix(p);
  return looksLikeWindowsPath(s) ? s.replace(/\//g, "\\") : s;
}

module.exports = {
  platform, isWindows, looksLikeWindowsPath, stripExtendedPrefix, separatorOf,
  joinPath, dirName, baseName, toFileUrl, openEntry, homeDir,
  adobeAppRoot, displayPath
};
