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

test("preserves paragraph boundaries as sentence pauses", () => {
  const raw =
    "Kind of, but not in the friendship way.\n\nYard bees are not studying cheekbones.";
  const spoken = toSpokenText(raw);
  assert.match(spoken, /way\.\s+Yard bees/i);
});

test("turns label-style line lists into separate spoken sentences", () => {
  const raw = `What they do learn is the stuff that actually matters to them:

Scent — soap, laundry detergent, sweat, the garden itself
How she moves — slow and calm vs. flailing
Colors and shapes — hats, shirts, hair`;
  const spoken = toSpokenText(raw);
  assert.match(spoken, /matters to them\./i);
  assert.match(spoken, /garden itself\.\s+How she moves/i);
  assert.match(spoken, /flailing\.\s+Colors and shapes/i);
  assert.doesNotMatch(spoken, /itself How she moves/i);
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
