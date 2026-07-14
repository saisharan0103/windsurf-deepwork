import test from "node:test";
import assert from "node:assert/strict";
import { contractPathViolation, matchesScope } from "../src/security/scope-policy.js";

test("scope matching follows the host filesystem case rules", () => {
  assert.equal(matchesScope("src/feature.js", "src/**"), true);
  if (process.platform === "win32") {
    assert.equal(matchesScope("SRC/FEATURE.JS", "src/**"), true);
    assert.match(
      contractPathViolation("SRC/secret.js", { protectedPaths: ["src/secret.js"] }) || "",
      /protected/
    );
  } else {
    assert.equal(matchesScope("SRC/FEATURE.JS", "src/**"), false);
  }
});
