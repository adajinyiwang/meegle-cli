const assert = require("assert");
const test = require("node:test");

const { installAgentSkill } = require("../bin/install-wizard.js");

test("installAgentSkill requests the explicit skill list (meegle + meegle-sdlc)", () => {
  const calls = [];
  const result = installAgentSkill({
    runFn: (cmd, args) => { calls.push({ cmd, args }); },
  });
  assert.strictEqual(result, true);
  assert.strictEqual(calls.length, 1);

  const { cmd, args } = calls[0];
  assert.strictEqual(cmd, "npm");
  assert.deepStrictEqual(args.slice(0, 5), [
    "exec", "--yes", "--package=skills", "--", "skills",
  ]);
  assert.ok(args.includes("add"));
  assert.ok(args.includes("adajinyiwang/meegle-cli"));
  assert.ok(args.includes("-y"));
  assert.ok(args.includes("-g"));

  const sIndex = args.indexOf("-s");
  assert.ok(sIndex !== -1, "expected explicit -s skill list");
  assert.deepStrictEqual(args.slice(sIndex + 1, sIndex + 3), ["meegle", "meegle-sdlc"]);
});
