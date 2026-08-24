/**
 * Convert a raw Cursor Agent response into something tolerable to speak aloud.
 * Keeps outcome + questions; strips code, diffs, and huge dumps.
 * Preserves paragraph / list / sentence boundaries for TTS pacing.
 *
 * Sentence ends use normal punctuation. Paragraph and list-line boundaries use
 * {@link SPOKEN_STRUCTURE_PAUSE}, which the voice service turns into real silence
 * (longer than a period pause).
 */

/** Inserted between paragraphs / list lines; never sent to the TTS model. */
export const SPOKEN_STRUCTURE_PAUSE = "⟪P⟫";

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

  // Each entry is one paragraph's spoken units (already punctuated).
  const paragraphs: string[][] = [];

  const blocks = text
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);

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

    const units: string[] = [];

    if (listMarked || labelList || lineBrokenList) {
      let i = 0;
      if (listMarked) {
        while (i < lines.length && !/^(?:[-*•]|\d+[.)])\s+/.test(lines[i])) {
          pushSpokenUnit(units, lines[i]);
          i += 1;
        }
      }
      for (; i < lines.length; i++) {
        const item = lines[i].replace(/^(?:[-*•]|\d+[.)])\s+/, "").trim();
        pushSpokenUnit(units, item);
      }
    } else {
      // Prose paragraph: keep soft line wraps as spaces (sentence pauses only).
      const prose = lines
        .map((line) => line.replace(/^(?:[-*•]|\d+[.)])\s+/, "").trim())
        .join(" ")
        .replace(/[^\S\n]+/g, " ")
        .trim();
      pushSpokenUnit(units, prose);
    }

    if (units.length) paragraphs.push(units);
  }

  // Join: list lines → structure pause; paragraphs → structure pause; within
  // a single prose unit there is only sentence punctuation.
  const parts: string[] = [];
  for (let p = 0; p < paragraphs.length; p++) {
    if (p > 0) parts.push(SPOKEN_STRUCTURE_PAUSE);
    const units = paragraphs[p];
    for (let u = 0; u < units.length; u++) {
      if (u > 0) parts.push(SPOKEN_STRUCTURE_PAUSE);
      parts.push(units[u]);
    }
  }

  text = parts.join(" ");
  // Tidy punctuation spacing; leave the pause marker intact.
  text = text
    .replace(/\s+([,.!?;:])/g, "$1")
    .replace(/([.!?])\1+/g, "$1")
    .replace(/([.!?])(?=[A-Za-z])/g, "$1 ")
    .replace(/[^\S\n]+/g, " ")
    .replace(/\s*(⟪P⟫)\s*/g, ` ${SPOKEN_STRUCTURE_PAUSE} `)
    .replace(/\s+/g, " ")
    .trim();

  if (!text) return "Done.";

  if (text.length <= maxChars) return ensureSentence(text);

  // Prefer clipping before a structure pause or sentence end.
  const sliced = text.slice(0, maxChars);
  const cut = Math.max(
    sliced.lastIndexOf(` ${SPOKEN_STRUCTURE_PAUSE} `),
    sliced.lastIndexOf(". "),
    sliced.lastIndexOf("? "),
    sliced.lastIndexOf("! "),
  );
  const clipped = (cut > 80 ? sliced.slice(0, cut).trim() : `${sliced.trim()}…`).trim();
  return ensureSentence(clipped);
}

/**
 * Split spoken text into chunks separated by {@link SPOKEN_STRUCTURE_PAUSE}.
 * Used by the voice service to insert silence longer than a period pause.
 */
export function splitSpokenForPauses(spoken: string): string[] {
  return spoken
    .split(SPOKEN_STRUCTURE_PAUSE)
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter(Boolean);
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
  // Don't append a period after a trailing structure pause.
  const trimmed = text.trim();
  if (!trimmed || trimmed.endsWith(SPOKEN_STRUCTURE_PAUSE)) return trimmed;
  if (/[.!?…]["']?$/.test(trimmed)) return trimmed;
  return `${trimmed}.`;
}
