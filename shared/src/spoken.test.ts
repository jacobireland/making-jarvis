import assert from "node:assert/strict";
import { test } from "node:test";
import { toSpokenText } from "./spoken";

test("speaks short answers mostly as-is", () => {
  assert.equal(toSpokenText("PONG"), "PONG.");
});

test("strips code fences", () => {
  const raw = `Updated login.\n\n\`\`\`ts\nexport const x = 1;\n\`\`\`\n\nTests still fail.`;
  const spoken = toSpokenText(raw);
  assert.match(spoken, /Updated login/i);
  assert.match(spoken, /Tests still fail/i);
  assert.doesNotMatch(spoken, /export const/);
});

test("caps long responses", () => {
  const raw = "Word ".repeat(200);
  const spoken = toSpokenText(raw, { maxChars: 120 });
  assert.ok(spoken.length <= 140);
});

test("empty becomes Done", () => {
  assert.equal(toSpokenText("   "), "Done.");
  assert.equal(toSpokenText("```\ncode\n```"), "Done.");
});
