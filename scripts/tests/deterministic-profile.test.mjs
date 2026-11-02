import assert from "node:assert/strict";
import test from "node:test";
import { makeStrictDeterministicProfile, strictDeterministicSettings } from "../lib/deterministic-profile.mjs";

const base = {
  exe: "strata.exe",
  args: [
    "--spec", "4",
    "--mtp", "E:/models/mtp",
    "--prompt-cache", "8",
    "--adapt-swaps", "200",
    "--pcie-frac", "0.5",
  ],
  env: {
    STRATA_PARK_VRAM_DEVICE: "1",
    STRATA_PARK_VRAM_MIB: "4096",
  },
};

test("strict deterministic profile is idempotent and preserves unrelated settings", () => {
  const first = makeStrictDeterministicProfile(base);
  const second = makeStrictDeterministicProfile(first);
  assert.deepEqual(second, first);
  assert.notDeepEqual(first, base);
  assert.deepEqual(base.args.slice(0, 4), ["--spec", "4", "--mtp", "E:/models/mtp"]);
  assert.equal(first.args.filter(value => value === "--prompt-cache").length, 1);
  assert.equal(first.args[first.args.indexOf("--prompt-cache") + 1], "0");
  assert.equal(first.args[first.args.indexOf("--adapt-swaps") + 1], "0");
  assert.equal(first.args[first.args.indexOf("--adapt-async") + 1], "0");
  assert.equal(first.args[first.args.indexOf("--pcie-frac") + 1], "0");
  assert.equal(first.env.STRATA_ADAPT_ASYNC, "0");
  assert.equal(first.env.STRATA_PARK_VRAM_MIB, "4096");
});

test("strict settings are explicit and detached from internal state", () => {
  const settings = strictDeterministicSettings();
  assert.deepEqual(settings.arguments, {
    "--prompt-cache": "0",
    "--adapt-swaps": "0",
    "--adapt-async": "0",
    "--pcie-frac": "0",
  });
  settings.environment.STRATA_ADAPT_ASYNC = "1";
  assert.equal(strictDeterministicSettings().environment.STRATA_ADAPT_ASYNC, "0");
});

test("invalid profiles fail closed", () => {
  assert.throws(() => makeStrictDeterministicProfile(null), /JSON object/);
  assert.throws(() => makeStrictDeterministicProfile({ args: "--spec 4" }), /array/);
  assert.throws(() => makeStrictDeterministicProfile({ args: ["--spec", 4] }), /only strings/);
});
