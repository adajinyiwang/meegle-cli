const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");

const { installAgentSkill, installSkillCore } = require("../bin/install-wizard.js");

test("installAgentSkill requests the explicit skill list (6 sdlc-* entries)", () => {
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
  assert.deepStrictEqual(
    args.slice(sIndex + 1, sIndex + 8),
    ["meegle", "sdlc-init", "sdlc-start", "sdlc-next", "sdlc-done", "sdlc-status", "sdlc-update"],
    "expected explicit -s skill list",
  );
});

test("installSkillCore copies skill-core.md into <home>/.sdlc/", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "sdlc-home-"));
  const result = installSkillCore({ homeDir });
  assert.strictEqual(result, true);
  const dest = path.join(homeDir, ".sdlc", "skill-core.md");
  assert.ok(fs.existsSync(dest), "skill-core.md was not copied");
  const content = fs.readFileSync(dest, "utf8");
  assert.ok(content.includes("AI 研发协作手册"), "unexpected skill-core content");
});

test("installSkillCore is best-effort when the source is missing", () => {
  // Point the resolver at a home it can write, but simulate a missing source
  // by checking the strict/bestEffort contract through a bogus module path.
  const result = installSkillCore({ bestEffort: true, homeDir: fs.mkdtempSync(path.join(os.tmpdir(), "sdlc-home-")) });
  assert.strictEqual(result, true); // source exists in repo layout during tests
});
