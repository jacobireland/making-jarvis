/**
 * Convert a raw Cursor Agent response into something tolerable to speak aloud.
 * Keeps outcome + questions; strips code, diffs, and huge dumps.
 * Preserves paragraph / list / sentence boundaries as spoken pauses (punctuation),
 * so TTS does not rush through flattened bullet lists.
 */
export function toSpokenText(raw: string, options?: { maxChars?: number }): string {
  // High enough for short stories / multi-paragraph replies; still caps novels.
  const maxChars = options?.maxChars ?? 2500;
  let text = raw.replace(/\r\n/g, "\n").trim();
  if (!text) return "Done.";

  // Remove fenced code blocks.
  text = text.replace(/```[\s\S]*?```/g, "\n\n");
  // Remove indented code-ish lines when dense.
  text = text.replace(/^(?: {4}|\t).+$/gm, "");
  // Drop markdown images/links noise but keep link labels lightly.
  text = text.replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1");
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  // Collapse markdown emphasis / headings (keep the words).
  text = text.replace(/^#{1,6}\s+/gm, "");
  text = text.replace(/(\*\*|__)(.*?)\1/g, "$2");
  text = text.replace(/(\*|_)(.*?)\1/g, "$2");
  text = text.replace(/`([^`]+)`/g, "$1");
  // Drop obvious diff hunks / file path dumps.
  text = text.replace(/^diff --git[\s\S]*?(?=\n\S|$)/gm, "\n");
  text = text.replace(/^[±+\-]{3}\s.+$/gm, "");

  // Build spoken units from paragraphs / list items so boundaries become pauses.
  const blocks = text
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);

  const sentences: string[] = [];
  for (const block of blocks) {
    const lines = block
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    if (lines.length === 0) continue;

    const listMarked =
      lines.filter((line) => /^(?:[-*•]|\d+[.)])\s+/.test(line)).length >=
      Math.ceil(lines.length * 0.5);
    // Agent often emits label lists without bullets: "Scent — …" on their own lines.
    const labelList =
      lines.length >= 2 &&
      lines.filter((line) => /—/.test(line) && !/[.!?…]["']?$/.test(line)).length >=
        Math.ceil(lines.length * 0.5);
    // Multi-line block where lines are already separate thoughts (no end punct).
    const lineBrokenList =
      lines.length >= 2 &&
      lines.filter((line) => !/[.!?…]["']?$/.test(line) && line.length < 240).length ===
        lines.length;

    if (listMarked || labelList || lineBrokenList) {
      let i = 0;
      if (listMarked) {
        while (i < lines.length && !/^(?:[-*•]|\d+[.)])\s+/.test(lines[i])) {
          pushSpokenUnit(sentences, lines[i]);
          i += 1;
        }
      }
      for (; i < lines.length; i++) {
        const item = lines[i].replace(/^(?:[-*•]|\d+[.)])\s+/, "").trim();
        pushSpokenUnit(sentences, item);
      }
      continue;
    }

    // Prose paragraph: keep line breaks as spaces within the paragraph,
    // but do not glue separate paragraphs together without a boundary.
    const prose = lines
      .map((line) => line.replace(/^(?:[-*•]|\d+[.)])\s+/, "").trim())
      .join(" ")
      .replace(/[^\S\n]+/g, " ")
      .trim();
    pushSpokenUnit(sentences, prose);
  }

  text = sentences.join(" ").replace(/\s+/g, " ").trim();
  // Tidy punctuation spacing without wiping sentence boundaries.
  text = text
    .replace(/\s+([,.!?;:])/g, "$1")
    .replace(/([.!?])\1+/g, "$1")
    .replace(/([.!?])(?=[A-Za-z])/g, "$1 ")
    .replace(/\s+/g, " ")
    .trim();

  if (!text) return "Done.";

  if (text.length <= maxChars) return ensureSentence(text);

  const sliced = text.slice(0, maxChars);
  const cut = Math.max(
    sliced.lastIndexOf(". "),
    sliced.lastIndexOf("? "),
    sliced.lastIndexOf("! "),
  );
  const clipped = (cut > 80 ? sliced.slice(0, cut + 1) : `${sliced.trim()}…`).trim();
  return ensureSentence(clipped);
}

/** Append one speakable unit, ensuring it ends with sentence punctuation for TTS pauses. */
function pushSpokenUnit(out: string[], unit: string): void {
  let s = unit.replace(/\s+/g, " ").trim();
  if (!s) return;
  // "What they learn:" → spoken pause before the list items.
  if (/[:;]$/.test(s)) s = `${s.slice(0, -1).trim()}.`;
  else if (!/[.!?…]["']?$/.test(s)) s = `${s}.`;
  out.push(s);
}

function ensureSentence(text: string): string {
  if (/[.!?…]["']?$/.test(text)) return text;
  return `${text}.`;
}
