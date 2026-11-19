const STRICT_ARGUMENTS = new Map([
  ["--prompt-cache", "0"],
  ["--adapt-every", "0"],
  ["--adapt-swaps", "0"],
  ["--adapt-async", "0"],
  ["--pcie-frac", "0"],
]);

const STRICT_ENVIRONMENT = {
  STRATA_ADAPT_ASYNC: "0",
  STRATA_COMMIT_SYNC: "1",
  STRATA_IQ_MT_MIN: "1",
};

function setValueArgument(args, name, value) {
  const next = [];
  for (let index = 0; index < args.length; ++index) {
    if (args[index] !== name) {
      next.push(args[index]);
      continue;
    }
    if (index + 1 < args.length && !args[index + 1].startsWith("--")) ++index;
  }
  next.push(name, value);
  return next;
}

export function makeStrictDeterministicProfile(profile) {
  if (profile == null || typeof profile !== "object" || Array.isArray(profile))
    throw new TypeError("profile must be a JSON object");
  if (!Array.isArray(profile.args)) throw new TypeError("profile.args must be an array");
  if (!profile.args.every(value => typeof value === "string"))
    throw new TypeError("profile.args must contain only strings");
  if (profile.env != null && (typeof profile.env !== "object" || Array.isArray(profile.env)))
    throw new TypeError("profile.env must be a JSON object");

  const output = structuredClone(profile);
  for (const [name, value] of STRICT_ARGUMENTS) output.args = setValueArgument(output.args, name, value);
  output.env = { ...(output.env ?? {}), ...STRICT_ENVIRONMENT };
  return output;
}

export function strictDeterministicSettings() {
  return {
    arguments: Object.fromEntries(STRICT_ARGUMENTS),
    environment: { ...STRICT_ENVIRONMENT },
  };
}
