/**
 * Convert a raw Cursor Agent response into something tolerable to speak aloud.
 * Keeps outcome + questions; strips code, diffs, and huge dumps.
 */
export function toSpokenText(raw: string, options?: { maxChars?: number }): string {
  // High enough for short stories / multi-paragraph replies; still caps novels.
  const maxChars = options?.maxChars ?? 2500;
  let text = raw.replace(/\r\n/g, "\n").trim();
  if (!text) return "Done.";

  // Remove fenced code blocks.
  text = text.replace(/```[\s\S]*?```/g, " ");
  // Remove indented code-ish lines when dense.
  text = text.replace(/^(?: {4}|\t).+$/gm, " ");
  // Drop markdown images/links noise but keep link labels lightly.
  text = text.replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1");
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  // Collapse markdown emphasis / headings.
  text = text.replace(/^#{1,6}\s+/gm, "");
  text = text.replace(/(\*\*|__)(.*?)\1/g, "$2");
  text = text.replace(/(\*|_)(.*?)\1/g, "$2");
  text = text.replace(/`([^`]+)`/g, "$1");
  // Drop obvious diff hunks / file path dumps.
  text = text.replace(/^diff --git[\s\S]*?(?=\n\S|$)/gm, " ");
  text = text.replace(/^[±+\-]{3}\s.+$/gm, " ");

  text = text
    .split("\n")
    .map((line) => line.replace(/^[-*•]\s+/, "").trim())
    .filter(Boolean)
    .join(" ");

  text = text
    .replace(/\s+/g, " ")
    .replace(/\s+([,.!?])/g, "$1")
    .replace(/([.!?])\1+/g, "$1")
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

function ensureSentence(text: string): string {
  if (/[.!?…]["']?$/.test(text)) return text;
  return `${text}.`;
}
