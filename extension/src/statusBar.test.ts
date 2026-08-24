import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  voiceCursorStatusBarText,
  voiceCursorStatusBarTooltip,
} from "./statusBar";

describe("voiceCursorStatusBarText", () => {
  it("is only IDLE or LISTENING", () => {
    assert.equal(voiceCursorStatusBarText(true), "$(mic) Voice Cursor: LISTENING");
    assert.equal(voiceCursorStatusBarText(false), "$(unmute) Voice Cursor: IDLE");
  });
});

describe("voiceCursorStatusBarTooltip", () => {
  it("tells the user how to toggle without a toast", () => {
    assert.equal(
      voiceCursorStatusBarTooltip(true, true),
      "Click to turn off, or send now",
    );
    assert.equal(
      voiceCursorStatusBarTooltip(false, true),
      "Click to turn Voice Cursor off",
    );
    assert.equal(
      voiceCursorStatusBarTooltip(false, false),
      "Click to turn listening on",
    );
  });
});
