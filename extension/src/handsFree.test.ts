import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { shouldAutoRearm } from "./handsFree";

describe("shouldAutoRearm", () => {
  it("rearms only while the hands-free session is still on", () => {
    assert.equal(
      shouldAutoRearm({ sessionEnabled: true, autoRearm: true, cancelled: false }),
      true,
    );
    assert.equal(
      shouldAutoRearm({ sessionEnabled: false, autoRearm: true, cancelled: false }),
      false,
    );
    assert.equal(
      shouldAutoRearm({ sessionEnabled: true, autoRearm: false, cancelled: false }),
      false,
    );
    assert.equal(
      shouldAutoRearm({ sessionEnabled: true, autoRearm: true, cancelled: true }),
      false,
    );
  });
});
