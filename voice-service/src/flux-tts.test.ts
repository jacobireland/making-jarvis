import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pcmToWav } from "./flux-tts";

describe("pcmToWav", () => {
  it("writes a valid RIFF/WAVE header around PCM", () => {
    const pcm = Buffer.alloc(4800, 0); // 100ms @ 24kHz mono 16-bit
    const wav = pcmToWav(pcm, { sampleRate: 24_000, channels: 1, bitsPerSample: 16 });
    assert.equal(wav.length, 44 + pcm.length);
    assert.equal(wav.toString("ascii", 0, 4), "RIFF");
    assert.equal(wav.toString("ascii", 8, 12), "WAVE");
    assert.equal(wav.toString("ascii", 12, 16), "fmt ");
    assert.equal(wav.readUInt16LE(20), 1); // PCM
    assert.equal(wav.readUInt16LE(22), 1); // mono
    assert.equal(wav.readUInt32LE(24), 24_000);
    assert.equal(wav.toString("ascii", 36, 40), "data");
    assert.equal(wav.readUInt32LE(40), pcm.length);
  });

  it("trims a trailing odd byte for 16-bit alignment", () => {
    const pcm = Buffer.alloc(101, 1);
    const wav = pcmToWav(pcm);
    assert.equal(wav.readUInt32LE(40), 100);
    assert.equal(wav.length, 144);
  });
});
