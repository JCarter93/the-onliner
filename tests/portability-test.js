/**
 * Portability guard: the panel must not know it is on a Mac.
 *
 * Same shape as locked-access-test.js - a source-text assertion for a class
 * of bug no unit test reaches. The panel was built on a Mac, with Mac paths,
 * and every one of those paths is a Windows failure that nothing here can
 * exercise: the only Windows machine with Premiere on it is a colleague's edit
 * suite. So the rule is enforced structurally, and a path that creeps back in
 * fails the build on the Mac where it was written.
 *
 * What is forbidden in panel code:
 *
 *   - a literal platform root: /Applications, /Users/, ~/Library,
 *     Library/Application Support, /Volumes/, .app/Contents, launchctl
 *   - building a file URL by hand: "file:" + path - the shape differs by
 *     platform, so it goes through platform.toFileUrl
 *   - joining a path with a literal "/" - platform.joinPath keeps the
 *     separator the picked folder already uses
 *   - calling getEntryWithUrl anywhere but platform.openEntry, which tries
 *     both URL shapes
 *
 * js/platform.js is the one file allowed to name a root, and it is held to
 * the opposite rule: every Mac root it names must sit beside its Windows
 * counterpart.
 */

var passed = 0, failed = 0;
function ok(cond, label) { if (cond) passed++; else { failed++; print("FAIL  " + label); } }

var PANEL_FILES = ["js/app.js", "js/ppro.js", "js/fcpxml.js", "js/presets.js", "js/cepbridge.js", "js/burnin.js", "js/log.js",
                   "js/naming.js", "js/prefs.js", "index.html"];
var ROOT_HOLDER = "js/platform.js";

/** Blank comments and string bodies, keeping newlines so line numbers hold. */
function stripNoise(src) {
  var out = src.split("");
  var i = 0, n = src.length;
  var blank = function (from, to) {
    for (var k = from; k < to && k < n; k++) if (out[k] !== "\n") out[k] = " ";
  };
  while (i < n) {
    var two = src.substr(i, 2);
    if (two === "/*") { var end = src.indexOf("*/", i + 2); if (end === -1) end = n; blank(i, end + 2); i = end + 2; continue; }
    if (two === "//") { var nl = src.indexOf("\n", i); if (nl === -1) nl = n; blank(i, nl); i = nl; continue; }
    var ch = src[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      var j = i + 1;
      while (j < n && src[j] !== ch) { if (src[j] === "\\") j++; j++; }
      blank(i, j + 1); i = j + 1; continue;
    }
    i++;
  }
  return out.join("");
}

/** Blank only comments, so string literals are still inspected. */
function stripComments(src) {
  var out = src.split("");
  var i = 0, n = src.length;
  var blank = function (from, to) {
    for (var k = from; k < to && k < n; k++) if (out[k] !== "\n") out[k] = " ";
  };
  while (i < n) {
    var two = src.substr(i, 2);
    if (two === "/*") { var end = src.indexOf("*/", i + 2); if (end === -1) end = n; blank(i, end + 2); i = end + 2; continue; }
    if (two === "//") { var nl = src.indexOf("\n", i); if (nl === -1) nl = n; blank(i, nl); i = nl; continue; }
    var ch = src[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      var j = i + 1;
      while (j < n && src[j] !== ch) { if (src[j] === "\\") j++; j++; }
      i = j + 1; continue;
    }
    i++;
  }
  return out.join("");
}

function lineOf(src, index) { return src.slice(0, index).split("\n").length; }

function everyMatch(src, re) {
  var hits = [], m;
  re.lastIndex = 0;
  while ((m = re.exec(src)) !== null) { hits.push({ index: m.index, text: m[0] }); if (!re.global) break; }
  return hits;
}

var ROOTS = [
  [/\/Applications\b/g, "a literal /Applications"],
  [/\/Users\//g, "a literal /Users/"],
  [/~\/Library/g, "a literal ~/Library"],
  [/Library\/Application Support/g, "a literal Library/Application Support"],
  [/\/Volumes\//g, "a literal /Volumes/"],
  [/\.app\/Contents/g, "a literal .app/Contents"],
  [/launchctl/g, "launchctl"]
];

// --- 1. no platform root anywhere in panel code (strings included) ----------

PANEL_FILES.forEach(function (file) {
  var src = stripComments(readFile(file));
  ROOTS.forEach(function (pair) {
    everyMatch(src, pair[0]).forEach(function (hit) {
      ok(false, file + ":" + lineOf(src, hit.index) + " has " + pair[1] +
         " - the panel must not know which platform it is on; go through js/platform.js");
    });
  });
});
ok(true, "panel files scanned for platform roots (" + PANEL_FILES.length + " files)");

// --- 2. no hand-built file URLs, no hand-joined paths ------------------------

PANEL_FILES.forEach(function (file) {
  var raw = readFile(file);
  var src = stripComments(raw);
  everyMatch(src, /["']file:["']\s*\+/g).forEach(function (hit) {
    ok(false, file + ":" + lineOf(src, hit.index) +
       " builds a file URL by hand - use platform.toFileUrl / platform.openEntry");
  });
  // A path being joined with a slash: `.path + "/"`, `nativePath + "/"`,
  // `Path + "/"`, `Dir + "/"`, `folder + "/"`. The bin walker's project-tree
  // path (node.path + "/" + name in findBins) is a Premiere bin path, not a
  // filesystem one, and is exempted by name.
  everyMatch(src, /\b(\w*(?:path|Path|Dir|dir|folder|Folder|home))\s*\+\s*["']\/["']/g).forEach(function (hit) {
    var line = raw.split("\n")[lineOf(src, hit.index) - 1] || "";
    if (/node\.path\s*\+\s*"\/"\s*\+\s*name/.test(line)) return;   // bin tree, not disk
    ok(false, file + ":" + lineOf(src, hit.index) + " joins a path with a literal \"/\" (" +
       hit.text.trim() + ") - use platform.joinPath, it keeps the folder's own separator");
  });
  everyMatch(src, /\.split\(\s*["']\/["']\s*\)\s*\.pop\(\)/g).forEach(function (hit) {
    ok(false, file + ":" + lineOf(src, hit.index) +
       " takes a basename by splitting on \"/\" - use platform.baseName");
  });
  everyMatch(src, /replace\(\s*\/\\\/\[\^\/\]\*\$\//g).forEach(function (hit) {
    ok(false, file + ":" + lineOf(src, hit.index) +
       " takes a dirname with a slash-only regex - use platform.dirName");
  });
  everyMatch(stripNoise(raw), /getEntryWithUrl\s*\(/g).forEach(function (hit) {
    ok(false, file + ":" + lineOf(src, hit.index) +
       " calls getEntryWithUrl directly - only platform.openEntry may, it tries both URL shapes");
  });
});
ok(true, "panel files scanned for hand-built URLs and joins");

// --- 3. platform.js names every root in pairs --------------------------------

var pl = stripComments(readFile(ROOT_HOLDER));
ok(/\/Applications\//.test(pl), "platform.js carries the Mac app root");
ok(/Program Files/.test(pl), "platform.js carries the Windows app root beside it");
ok(/function adobeAppRoot/.test(pl) && /windows/.test(pl.slice(pl.indexOf("function adobeAppRoot"))),
   "adobeAppRoot branches on windows");
ok(/function toFileUrl/.test(pl), "platform.js owns toFileUrl");
ok(/function openEntry/.test(pl) && /getEntryWithUrl/.test(stripNoise(readFile(ROOT_HOLDER))),
   "platform.js owns the only getEntryWithUrl call");
ok(!/~\/Library|Library\/Application Support|launchctl/.test(pl),
   "platform.js does not reach for the Mac Library folder either");

// --- 4. the modules that touch disk actually use the helper ---------------------

var app = stripNoise(readFile("js/app.js"));
ok(/platform\.joinPath\(/.test(app), "app.js joins destination paths with platform.joinPath");
ok(/require\(\s*["']\.\/js\/platform["']\s*\)/.test(readFile("js/app.js")), "app.js requires ./js/platform (root-relative, as UXP needs)");
var presets = stripNoise(readFile("js/presets.js"));
ok(/platform\.openEntry\(/.test(presets), "presets.js opens its unpicked folders with platform.openEntry");
ok(/platform\.adobeAppRoot\(/.test(presets), "presets.js gets the AME root from platform.adobeAppRoot");
var fcp = stripNoise(readFile("js/fcpxml.js"));
ok(/folderEntry/.test(fcp) && /getEntry\(/.test(fcp), "fcpxml.js reads the exported XML through the picked folder entry");
var ppro = stripNoise(readFile("js/ppro.js"));
ok(/folderEntry/.test(ppro) && /getEntry\(/.test(ppro), "ppro.js verifies the export through the picked folder entry");

// --- 5. the installers come in pairs ---------------------------------------------

["scripts/install-dev.sh", "scripts/install-dev.ps1",
 "scripts/uninstall-dev.sh", "scripts/uninstall-dev.ps1"].forEach(function (f) {
  var present = true;
  try { readFile(f); } catch (e) { present = false; }
  ok(present, f + " exists - every installer has a counterpart on the other platform");
});

print("");
print(passed + " passed, " + failed + " failed");
if (failed > 0) throw new Error(failed + " test(s) failed");
