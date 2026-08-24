import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createTimedLogger,
  formatLogClock,
  stampLogMessage,
  stampOutputChannel,
} from "./log";

describe("formatLogClock", () => {
  it("formats HH:MM:SS.mmm", () => {
    const now = new Date("2026-08-24T16:39:17.230Z");
    const clock = formatLogClock(now);
    assert.match(clock, /^\d{2}:\d{2}:\d{2}\.\d{3}$/);
    assert.ok(clock.endsWith("17.230"));
  });
});

describe("stampLogMessage", () => {
  it("prefixes every line including blanks", () => {
    const now = new Date("2026-08-24T16:39:17.230Z");
    const clock = formatLogClock(now);
    assert.deepEqual(stampLogMessage("hello", now), [`[${clock}] hello`]);
    assert.deepEqual(stampLogMessage("a\nb\n", now), [
      `[${clock}] a`,
      `[${clock}] b`,
      `[${clock}] `,
    ]);
  });
});

describe("stampOutputChannel", () => {
  it("stamps each appendLine, splitting multiline dumps", () => {
    const lines: string[] = [];
    const channel = stampOutputChannel({
      appendLine(value: string) {
        lines.push(value);
      },
    });
    channel.appendLine("one");
    channel.appendLine("two\nthree");
    assert.equal(lines.length, 3);
    assert.match(lines[0], /^\[\d{2}:\d{2}:\d{2}\.\d{3}\] one$/);
    assert.match(lines[1], /^\[\d{2}:\d{2}:\d{2}\.\d{3}\] two$/);
    assert.match(lines[2], /^\[\d{2}:\d{2}:\d{2}\.\d{3}\] three$/);
  });
});

describe("createTimedLogger", () => {
  it("adds elapsed ms; clock is applied by the writer", () => {
    const written: string[] = [];
    const log = createTimedLogger((message) => written.push(message), {
      startedAt: Date.now() - 40,
    });
    log("[ptt] stopping mic");
    assert.equal(written.length, 1);
    assert.match(written[0], /^\+\d+ms \[ptt\] stopping mic$/);
  });
});
