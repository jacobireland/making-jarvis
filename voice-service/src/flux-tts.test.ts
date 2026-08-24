import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fluxSpeakUrl, parseFluxExpressivity, pcmToWav } from "./flux-tts";

describe("parseFluxExpressivity", () => {
  it("defaults to 0 when unset", () => {
    assert.equal(parseFluxExpressivity(undefined), 0);
    assert.equal(parseFluxExpressivity(""), 0);
    assert.equal(parseFluxExpressivity("  "), 0);
  });

  it("accepts integers in -2..2", () => {
    assert.equal(parseFluxExpressivity("-2"), -2);
    assert.equal(parseFluxExpressivity("-1"), -1);
    assert.equal(parseFluxExpressivity("0"), 0);
    assert.equal(parseFluxExpressivity("1"), 1);
    assert.equal(parseFluxExpressivity("2"), 2);
  });

  it("accepts calm/animated aliases", () => {
    assert.equal(parseFluxExpressivity("calm"), -2);
    assert.equal(parseFluxExpressivity("subdued"), -1);
    assert.equal(parseFluxExpressivity("quiet"), -1);
    assert.equal(parseFluxExpressivity("default"), 0);
    assert.equal(parseFluxExpressivity("lively"), 1);
    assert.equal(parseFluxExpressivity("animated"), 2);
    assert.equal(parseFluxExpressivity("CALM"), -2);
  });

  it("falls back to 0 for invalid values", () => {
    assert.equal(parseFluxExpressivity("1.5"), 0);
    assert.equal(parseFluxExpressivity("3"), 0);
    assert.equal(parseFluxExpressivity("-3"), 0);
    assert.equal(parseFluxExpressivity("loud"), 0);
  });
});

describe("fluxSpeakUrl", () => {
  it("puts expressivity on the /v2/speak query string", () => {
    const url = fluxSpeakUrl({ model: "flux-marcelo-en", expressivity: 1 });
    assert.match(url, /^wss:\/\/api\.deepgram\.com\/v2\/speak\?/);
    assert.match(url, /model=flux-marcelo-en/);
    assert.match(url, /encoding=linear16/);
    assert.match(url, /sample_rate=24000/);
    assert.match(url, /expressivity=1/);
  });

  it("defaults expressivity to 0", () => {
    const url = fluxSpeakUrl({ model: "flux-marcelo-en" });
    assert.match(url, /expressivity=0/);
  });
});


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
