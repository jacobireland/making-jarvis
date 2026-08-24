import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_EOT_THRESHOLD,
  FLUX_KEEPALIVE,
  fluxListenUrl,
  parseFluxListenMessage,
  shouldCommitFluxTurn,
} from "./flux-stt";

describe("fluxListenUrl", () => {
  it("uses /v2/listen with Flux model and raw PCM params", () => {
    const url = fluxListenUrl({ eotThreshold: 0.7, eotTimeoutMs: 7000 });
    assert.match(url, /^wss:\/\/api\.deepgram\.com\/v2\/listen\?/);
    assert.match(url, /model=flux-general-en/);
    assert.match(url, /encoding=linear16/);
    assert.match(url, /sample_rate=16000/);
    assert.match(url, /eot_threshold=0\.7/);
    assert.match(url, /eot_timeout_ms=7000/);
    assert.doesNotMatch(url, /eager_eot/);
  });
});

describe("shouldCommitFluxTurn", () => {
  it("commits EndOfTurn with a real transcript", () => {
    assert.equal(
      shouldCommitFluxTurn({ event: "EndOfTurn", transcript: "refactor the inject prompt" }),
      true,
    );
  });

  it("ignores empty or tiny EndOfTurn", () => {
    assert.equal(shouldCommitFluxTurn({ event: "EndOfTurn", transcript: "" }), false);
    assert.equal(shouldCommitFluxTurn({ event: "EndOfTurn", transcript: "  " }), false);
    assert.equal(shouldCommitFluxTurn({ event: "EndOfTurn", transcript: "a" }), false);
  });

  it("does not commit Update / StartOfTurn / EagerEndOfTurn", () => {
    const text = "hello there";
    assert.equal(shouldCommitFluxTurn({ event: "Update", transcript: text }), false);
    assert.equal(shouldCommitFluxTurn({ event: "StartOfTurn", transcript: text }), false);
    assert.equal(shouldCommitFluxTurn({ event: "EagerEndOfTurn", transcript: text }), false);
    assert.equal(shouldCommitFluxTurn({ event: "TurnResumed", transcript: text }), false);
  });
});

describe("FLUX_KEEPALIVE", () => {
  it("is the Deepgram listen keepalive payload", () => {
    assert.equal(FLUX_KEEPALIVE.type, "KeepAlive");
  });
});

describe("parseFluxListenMessage", () => {
  it("reads a TurnInfo EndOfTurn payload", () => {
    const msg = parseFluxListenMessage(
      JSON.stringify({
        type: "TurnInfo",
        event: "EndOfTurn",
        transcript: "open a new chat",
        end_of_turn_confidence: DEFAULT_EOT_THRESHOLD,
      }),
    );
    assert.ok(msg);
    assert.equal(msg?.type, "TurnInfo");
    assert.equal(msg?.event, "EndOfTurn");
    assert.equal(shouldCommitFluxTurn(msg!), true);
  });

  it("returns null for garbage", () => {
    assert.equal(parseFluxListenMessage("not-json"), null);
  });
});
