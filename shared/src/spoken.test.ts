import assert from "node:assert/strict";
import { test } from "node:test";
import { toSpokenText, toSpokenThoughtText } from "./spoken";

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

test("thought preview speaks only the last sentence", () => {
  const raw = `The research on honeybee face recognition is interesting.
Adrian Dyer trained bees on face-like stimuli and found configural processing.
That is lab training, not what wild bees do in a garden.

I'll check the research on honeybee face recognition so the answer matches what was actually shown, not just the headline.`;
  const spoken = toSpokenThoughtText(raw);
  assert.match(spoken, /I'll check the research on honeybee face recognition/i);
  assert.match(spoken, /not just the headline/i);
  assert.doesNotMatch(spoken, /Adrian Dyer/i);
  assert.doesNotMatch(spoken, /configural/i);
  assert.doesNotMatch(spoken, /wild bees/i);
});

test("thought preview takes last sentence from a single long paragraph", () => {
  const raw =
    "First I consider the lab results and what configural processing means for bees. Then I weigh wild behavior versus training. I'll check the research on honeybee face recognition so the answer matches what was actually shown, not just the headline.";
  const spoken = toSpokenThoughtText(raw);
  assert.match(spoken, /I'll check the research/i);
  assert.doesNotMatch(spoken, /configural processing/i);
});

test("thought full mode keeps expanded reasoning", () => {
  const raw =
    "Lab bees can do faces.\n\nI'll check the research on honeybee face recognition so the answer matches what was actually shown, not just the headline.";
  const spoken = toSpokenThoughtText(raw, { full: true });
  assert.match(spoken, /Lab bees can do faces/i);
  assert.match(spoken, /I'll check the research/i);
});
