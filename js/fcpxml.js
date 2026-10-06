/**
 * fcpxml.js - post-processing of the exported FCP7 XML.
 *
 * Premiere cannot delete a track. Tracks can be counted, read, renamed and
 * muted; there is no add or remove anywhere in the UXP API, so a grade timeline
 * always carries the source's full track count with most of them empty - the
 * V6 teaser exported 10 video tracks with clips on one, and 30 audio tracks
 * with clips on none.
 *
 * The deliverable is a file, though, so the empty tracks come out of the XML
 * instead. Same end result for the colourist, and the Premiere sequence is left
 * alone.
 *
 * No XML DOM is available in UXP, so this scans the text. That is normally a
 * bad idea, which is why every operation here is checked: the clipitem count
 * must be identical before and after, or the result is thrown away.
 */

/** Index of the matching close tag for the element starting at `open`. */
function findElementEnd(xml, open, tag) {
  const openTag = "<" + tag;
  const closeTag = "</" + tag + ">";
  let depth = 0;
  // Start AFTER the element's own opening tag - counting it as nesting is what
  // made the first version find no tracks at all.
  let i = open + openTag.length;
  while (i < xml.length) {
    const nextOpen = xml.indexOf(openTag, i);
    const nextClose = xml.indexOf(closeTag, i);
    if (nextClose === -1) return -1;
    if (nextOpen !== -1 && nextOpen < nextClose) {
      // Only counts as nesting if it is really <tag or <tag ... >, not <tagfoo.
      const after = xml.charAt(nextOpen + openTag.length);
      if (after === ">" || after === " " || after === "\n" || after === "\t" || after === "\r" || after === "/") {
        depth++;
      }
      i = nextOpen + openTag.length;
    } else {
      if (depth === 0) return nextClose + closeTag.length;
      depth--;
      i = nextClose + closeTag.length;
    }
  }
  return -1;
}

function countOccurrences(xml, needle) {
  let n = 0;
  let i = xml.indexOf(needle);
  while (i !== -1) {
    n++;
    i = xml.indexOf(needle, i + needle.length);
  }
  return n;
}

/**
 * Remove every <track> that holds no <clipitem>.
 *
 * Returns { xml, removed, keptWithClips, clipitemsBefore, clipitemsAfter }.
 * Throws if the clipitem count changed - that would mean the scan cut into
 * something it should not have, and a grade XML short of shots is exactly the
 * failure this tool exists to prevent.
 *
 * Removing an empty track never changes layer order: the populated tracks keep
 * their relative sequence, the gaps just close up.
 */
function stripEmptyTracks(xmlText) {
  const xml = String(xmlText == null ? "" : xmlText);
  const clipitemsBefore = countOccurrences(xml, "<clipitem");

  const spans = [];
  let searchFrom = 0;
  let removed = 0;
  let keptWithClips = 0;

  while (true) {
    const open = xml.indexOf("<track", searchFrom);
    if (open === -1) break;
    const after = xml.charAt(open + 6);
    if (!(after === ">" || after === " " || after === "\n" || after === "\t" || after === "\r")) {
      searchFrom = open + 6;
      continue;
    }
    const end = findElementEnd(xml, open, "track");
    if (end === -1) break;

    const body = xml.slice(open, end);
    if (body.indexOf("<clipitem") === -1) {
      spans.push([open, end]);
      removed++;
    } else {
      keptWithClips++;
    }
    searchFrom = end;
  }

  // Cut from the end so earlier offsets stay valid.
  let out = xml;
  for (let i = spans.length - 1; i >= 0; i--) {
    let [start, end] = spans[i];
    // Take the whitespace before the tag too, so the file does not fill with
    // blank lines where tracks used to be.
    while (start > 0 && (out.charAt(start - 1) === " " || out.charAt(start - 1) === "\t")) start--;
    if (start > 0 && out.charAt(start - 1) === "\n") start--;
    out = out.slice(0, start) + out.slice(end);
  }

  const clipitemsAfter = countOccurrences(out, "<clipitem");
  if (clipitemsAfter !== clipitemsBefore) {
    throw new Error(
      "Refusing to strip empty tracks: the clip count changed from " + clipitemsBefore +
      " to " + clipitemsAfter + ". The original XML has been left untouched.");
  }

  return { xml: out, removed, keptWithClips, clipitemsBefore, clipitemsAfter };
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

/**
 * Open a file in a folder the editor picked, by name, falling back to the
 * path when no entry was handed in.
 *
 * The entry route is the one that works everywhere: UXP lists the folder the
 * picker granted, on either platform, with no URL to get right. The path
 * route exists for callers that only have a string, and goes through
 * platform.openEntry so the URL shape is decided in one place. Note The
 * Conformer learned that getEntryWithUrl can throw for a file that is
 * demonstrably on disk when the folder sits outside the granted scope - a
 * false negative that makes a successful export look failed - which is why
 * the entry is preferred whenever there is one.
 */
async function openFileAt(path, folderEntry) {
  const platform = requireSibling("platform");
  if (folderEntry && typeof folderEntry.getEntry === "function") {
    try {
      return await folderEntry.getEntry(platform.baseName(path));
    } catch (e) { /* fall through to the path */ }
  }
  return await platform.openEntry(path);
}

/**
 * Strip empty tracks from an exported XML in place.
 *
 * The file is only overwritten once stripEmptyTracks has confirmed the clip
 * count is unchanged; if anything looks wrong it throws and the original XML
 * on disk is left exactly as Premiere wrote it.
 *
 * `folderEntry` is the picked destination folder, when the caller has it.
 */
async function stripEmptyTracksInFile(path, folderEntry) {
  const entry = await openFileAt(path, folderEntry);
  if (!entry) throw new Error("The exported XML could not be opened at " + path);
  const before = String(await entry.read());
  const result = stripEmptyTracks(before);
  if (result.removed === 0) return { removed: 0, keptWithClips: result.keptWithClips, rewritten: false };
  await entry.write(result.xml);
  return {
    removed: result.removed,
    keptWithClips: result.keptWithClips,
    clips: result.clipitemsAfter,
    rewritten: true
  };
}

/**
 * Parse Premiere's "FCP Translation Results" report.
 *
 * Premiere drops one of these beside every FCPXML it writes, listing everything
 * the export could not carry - and nothing surfaces it, so it goes unread. It
 * is how we learned that Warp Stabilizer is silently dropped from FCP7 XML.
 *
 * Format is pairs of lines:
 *
 *     Translation issue:
 *     \t<the actual message>
 *
 * Returns the messages, de-duplicated, in file order.
 */
function parseTranslationReport(text) {
  const raw = String(text == null ? "" : text).replace(/^\uFEFF/, "");
  const lines = raw.split(/\r?\n/);
  const messages = [];
  const seen = Object.create(null);

  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*Translation issue:\s*$/i.test(lines[i])) continue;
    // The message is the next non-blank line.
    for (let j = i + 1; j < lines.length; j++) {
      const candidate = lines[j].trim();
      if (!candidate) continue;
      if (/^Translation issue:/i.test(candidate)) break;
      if (!seen[candidate]) { seen[candidate] = true; messages.push(candidate); }
      break;
    }
  }
  return messages;
}

/** Tidy a report message for the panel: drop the noisy "Sequence <...> at ," prefix. */
function tidyTranslationMessage(message) {
  return String(message)
    .replace(/^Sequence\s+<[^>]*>\s+at\s*,?\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Find and read the translation report Premiere wrote for a given export.
 *
 * Reports are named by timestamp, not by sequence, so several accumulate in a
 * destination folder. The right one is identified by the sequence name INSIDE
 * it - matching on newest-file alone would pick up someone else's export that
 * happened to land in the same folder.
 *
 * `folder` is the picked destination folder entry, or its native path.
 */
async function readTranslationReport(folder, sequenceName) {
  let entries;
  try {
    // A picked folder ENTRY is listed directly; a bare path is opened first.
    const entry = (folder && typeof folder.getEntries === "function")
      ? folder
      : await requireSibling("platform").openEntry(folder);
    if (!entry) throw new Error("folder not found: " + folder);
    entries = await entry.getEntries();
  } catch (e) {
    return { found: false, messages: [], error: String(e.message || e) };
  }

  const reports = entries.filter((e) => !e.isFolder && /^FCP Translation Results.*\.txt$/i.test(e.name));
  let best = null;
  for (const entry of reports) {
    let text = "";
    try { text = String(await entry.read()); } catch (e) { continue; }
    if (sequenceName && text.indexOf(sequenceName) === -1) continue;
    // Later timestamps sort later by name, so the last match is the newest.
    best = { name: entry.name, text };
  }
  if (!best) return { found: false, messages: [] };

  const messages = parseTranslationReport(best.text);
  return {
    found: true,
    file: best.name,
    messages,
    tidied: messages.map(tidyTranslationMessage)
  };
}

module.exports = {
  stripEmptyTracks, stripEmptyTracksInFile, findElementEnd, countOccurrences,
  parseTranslationReport, tidyTranslationMessage, readTranslationReport
};
