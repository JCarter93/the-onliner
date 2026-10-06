/**
 * Tests for js/platform.js - the path helpers that let the panel run on
 * Windows as well as a Mac.
 *
 * These are pure string functions, so they are tested properly here. The one
 * thing they cannot prove is what the UXP host accepts, which is why the URL
 * shapes below are the ones Adobe's own Premiere UXP recipe prints, not ones
 * guessed from the file: scheme in general.
 */

var module = { exports: {} };
(new Function("module", "exports", "require", readFile("js/platform.js")))(
  module, module.exports, function (name) { throw new Error("no host module: " + name); }
);
var PL = module.exports;

var passed = 0, failed = 0;
function eq(actual, expected, label) {
  var a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) passed++;
  else { failed++; print("FAIL  " + label + "\n      expected " + e + "\n      got      " + a); }
}
function ok(cond, label) { if (cond) passed++; else { failed++; print("FAIL  " + label); } }

// --- platform() without a host -----------------------------------------------

eq(PL.platform(), "unknown", "no os module and no sample path is unknown, not a guess");
eq(PL.platform("C:\\Users\\edit\\Documents"), "windows", "a drive letter sample reads as Windows");
eq(PL.platform("/Users/edit/Documents"), "mac", "a POSIX sample reads as Mac");
eq(PL.isWindows(), false, "isWindows is false where nothing says otherwise");

// --- looksLikeWindowsPath ---------------------------------------------------

ok(PL.looksLikeWindowsPath("C:\\Users\\x"), "backslash drive path");
ok(PL.looksLikeWindowsPath("C:/Users/x"), "forward-slash drive path");
ok(PL.looksLikeWindowsPath("\\\\server\\share\\x"), "UNC path");
ok(!PL.looksLikeWindowsPath("/Volumes/M/x"), "a Mac volume is not Windows");
ok(!PL.looksLikeWindowsPath(""), "empty is not Windows");
ok(!PL.looksLikeWindowsPath(null), "null is not Windows, not a crash");

// --- joinPath ---------------------------------------------------------------

eq(PL.joinPath("/Users/edit/refs", "MyEdit_REF"), "/Users/edit/refs/MyEdit_REF", "Mac join");
eq(PL.joinPath("/Users/edit/refs/", "MyEdit_REF"), "/Users/edit/refs/MyEdit_REF", "Mac join tolerates a trailing slash");
eq(PL.joinPath("C:\\Users\\edit\\refs", "MyEdit_REF.xml"), "C:\\Users\\edit\\refs\\MyEdit_REF.xml", "Windows join keeps backslashes");
eq(PL.joinPath("C:\\Users\\edit\\refs\\", "MyEdit_REF.xml"), "C:\\Users\\edit\\refs\\MyEdit_REF.xml", "Windows join tolerates a trailing backslash");
eq(PL.joinPath("C:/Users/edit/refs", "a.xml"), "C:/Users/edit/refs/a.xml", "a forward-slash Windows path stays forward-slash");
eq(PL.joinPath("\\\\server\\share", "a.aaf"), "\\\\server\\share\\a.aaf", "UNC join");
eq(PL.joinPath("/Users/edit", "Documents", "Adobe", "Presets"), "/Users/edit/Documents/Adobe/Presets", "variadic on Mac");
eq(PL.joinPath("C:\\Program Files\\Adobe", "MediaIO", "systempresets"), "C:\\Program Files\\Adobe\\MediaIO\\systempresets", "variadic on Windows");
eq(PL.joinPath("/a", "/b"), "/a/b", "a leading slash on the segment does not double up");
eq(PL.joinPath("", "b"), "b", "empty dir gives the bare name");
eq(PL.joinPath("/a", ""), "/a", "empty name gives the dir");
eq(PL.joinPath(null, "b"), "b", "null dir is tolerated");

// --- dirName / baseName -----------------------------------------------------

eq(PL.dirName("/tmp/grade/MyEdit_FOR_GRADE.xml"), "/tmp/grade", "Mac dirName");
eq(PL.dirName("C:\\tmp\\grade\\MyEdit.xml"), "C:\\tmp\\grade", "Windows dirName");
eq(PL.dirName("MyEdit.xml"), "", "no folder is empty, not the file");
eq(PL.baseName("/tmp/grade/MyEdit_FOR_GRADE.xml"), "MyEdit_FOR_GRADE.xml", "Mac baseName");
eq(PL.baseName("C:\\tmp\\grade\\MyEdit.xml"), "MyEdit.xml", "Windows baseName");
eq(PL.baseName("/Volumes/P/FULLRES_H264.epr"), "FULLRES_H264.epr", "preset name off a Mac path");
eq(PL.baseName("C:\\P\\FULLRES_H264.epr"), "FULLRES_H264.epr", "preset name off a Windows path");
eq(PL.baseName("plain.xml"), "plain.xml", "no folder is the whole thing");

// --- toFileUrl: the shapes from Adobe's Premiere UXP recipe ------------------

eq(PL.toFileUrl("/Users/user/Documents"), "file:/Users/user/Documents", "Mac form, as the recipe prints it");
eq(PL.toFileUrl("C:\\Users\\user\\Documents"), "file:/C:/Users/user/Documents", "Windows form, as the recipe prints it");
eq(PL.toFileUrl("C:/Users/user/Documents"), "file:/C:/Users/user/Documents", "forward-slash Windows input gives the same URL");
eq(PL.toFileUrl("\\\\server\\share\\x"), "file://server/share/x", "UNC becomes a host-form file URL");
eq(PL.toFileUrl("file:/Users/x"), "file:/Users/x", "an existing file: URL passes through");
eq(PL.toFileUrl("plugin-data:/settings.json"), "plugin-data:/settings.json", "a UXP scheme passes through");
eq(PL.toFileUrl(""), "", "empty stays empty");
eq(PL.toFileUrl(null), "", "null is empty, not 'null'");
ok(PL.toFileUrl("C:\\x").indexOf("file:/C:") === 0, "a drive letter is never mistaken for a URL scheme");

// --- adobeAppRoot -------------------------------------------------------------

eq(PL.adobeAppRoot("Adobe Media Encoder", "2026", "mac"),
   "/Applications/Adobe Media Encoder 2026/Adobe Media Encoder 2026.app/Contents",
   "Mac app root goes inside the bundle");
eq(PL.adobeAppRoot("Adobe Media Encoder", "2026", "windows"),
   "C:\\Program Files\\Adobe\\Adobe Media Encoder 2026",
   "Windows app root is the install folder");
eq(PL.joinPath(PL.adobeAppRoot("Adobe Media Encoder", "2025", "windows"), "MediaIO", "systempresets"),
   "C:\\Program Files\\Adobe\\Adobe Media Encoder 2025\\MediaIO\\systempresets",
   "Windows systempresets path matches Adobe's support thread");
eq(PL.joinPath(PL.adobeAppRoot("Adobe Media Encoder", "2026", "mac"), "MediaIO", "systempresets"),
   "/Applications/Adobe Media Encoder 2026/Adobe Media Encoder 2026.app/Contents/MediaIO/systempresets",
   "Mac systempresets path is the one that worked before the port");

// --- the \\?\ prefix Premiere 26.5.2 on Windows puts on project.path -----------

eq(PL.stripExtendedPrefix("\\\\?\\C:\\Users\\e\\p.prproj"), "C:\\Users\\e\\p.prproj", "local extended path loses the prefix");
eq(PL.stripExtendedPrefix("\\\\?\\UNC\\srv\\share\\x"), "\\\\srv\\share\\x", "extended UNC becomes plain UNC");
eq(PL.stripExtendedPrefix("C:\\x"), "C:\\x", "a plain path is untouched");
eq(PL.toFileUrl("\\\\?\\C:\\Users\\e"), "file:/C:/Users/e", "the URL of an extended path is the plain path's URL");
eq(PL.displayPath("\\\\?\\C:\\Users\\e\\p.prproj"), "C:\\Users\\e\\p.prproj", "an extended path displays plain");
ok(PL.looksLikeWindowsPath("\\\\?\\C:\\x"), "an extended path still reads as Windows");

// --- displayPath ------------------------------------------------------------

eq(PL.displayPath("C:/Users/x/a.xml"), "C:\\Users\\x\\a.xml", "Windows paths display with backslashes");
eq(PL.displayPath("/Users/x/a.xml"), "/Users/x/a.xml", "Mac paths are left alone");

// --- presets.js builds its folders through platform.js ------------------------

var pmod = { exports: {} };
(new Function("module", "exports", "require", readFile("js/presets.js")))(
  pmod, pmod.exports, function (name) {
    if (name === "./js/platform") return PL;
    throw new Error("no host module: " + name);
  }
);
var PR = pmod.exports;

eq(PR.userPresetDirs(null), [], "no home folder means no user preset folders, not a crash");

// Adobe's localisation wrapper, including names that hold parentheses.
eq(PR.parsePresetName("<PresetName>($$$/AME/EncoderHost/Presets/05ED/PresetName=Match Source (Rewrap))</PresetName>", "x"),
   "Match Source (Rewrap)", "a localised name keeps its own parentheses");
eq(PR.parsePresetName("<PresetName>($$$/AME/EncoderHost/Presets/0738/PresetName=HD 1080i 25 (1.33 PAR))</PresetName>", "x"),
   "HD 1080i 25 (1.33 PAR)", "a localised name keeps a parenthesised suffix");
eq(PR.parsePresetName("<PresetName>($$$/AME/.../PresetName=Apple ProRes 422 HQ)</PresetName>", "x"),
   "Apple ProRes 422 HQ", "a plain localised name");
eq(PR.parsePresetName("<PresetName>FULLRES_H264</PresetName>", "x"), "FULLRES_H264", "an unwrapped name is used as-is");
eq(PR.parsePresetName("<nothing/>", "fallback.epr"), "fallback.epr", "no name falls back to the filename");
eq(PR.userPresetDirs("/Users/edit")[0], "/Users/edit/Documents/Adobe/Adobe Media Encoder/26.0/Presets",
   "Mac user presets, newest AME first");
eq(PR.userPresetDirs("C:\\Users\\edit")[0], "C:\\Users\\edit\\Documents\\Adobe\\Adobe Media Encoder\\26.0\\Presets",
   "Windows user presets under Documents, as Reveal Preset File shows");
ok(PR.appPresetDirs("windows").every(function (d) { return /^C:\\Program Files\\Adobe\\Adobe Media Encoder 20\d\d\\MediaIO\\systempresets$/.test(d); }),
   "every Windows app preset folder has the verified layout");
ok(PR.appPresetDirs("mac").every(function (d) { return /^\/Applications\/.*\.app\/Contents\/MediaIO\/systempresets$/.test(d); }),
   "every Mac app preset folder is inside the bundle");
ok(PR.appPresetDirs("mac").length >= 2 && PR.appPresetDirs("windows").length === PR.appPresetDirs("mac").length,
   "both platforms search the same set of AME releases");
var src = PR.presetSources();
eq(src.home, null, "under jsc there is no home folder");
eq(src.userDirs, [], "and so no user folders");
ok(src.appDirs.length > 0, "but the app folders are still listed");

print("");
print(passed + " passed, " + failed + " failed");
if (failed > 0) throw new Error(failed + " test(s) failed");
