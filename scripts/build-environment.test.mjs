import assert from "node:assert/strict";
import test from "node:test";
import { buildEnvironmentMismatches } from "./build-environment.mjs";

const cases = [
  ["x86_64-pc-windows-msvc", { os: "win32", arch: "x64" }, "Windows", "X64", "x86_64", null],
  ["aarch64-apple-darwin", { os: "darwin", arch: "arm64" }, "macOS", "ARM64", "arm64", "arm64"],
  ["x86_64-unknown-linux-gnu", { os: "linux", arch: "x64" }, "Linux", "X64", "x86_64", "x86_64"],
];

test("build environment accepts only native runner, Node and Rust host triples", () => {
  for (const [target, runner, githubRunnerOs, githubRunnerArch, machine, unameMachine] of cases) {
    assert.deepEqual(
      buildEnvironmentMismatches(target, runner, {
        nodePlatform: runner.os,
        nodeArch: runner.arch,
        machine,
        unameMachine,
        githubRunnerOs,
        githubRunnerArch,
        rustHost: target,
      }),
      [],
    );
  }
});

test("build environment reports each runner/target mismatch instead of accepting cross-build", () => {
  const errors = buildEnvironmentMismatches(
    "aarch64-apple-darwin",
    { os: "darwin", arch: "arm64" },
    {
      nodePlatform: "darwin",
      nodeArch: "x64",
      machine: "x64",
      unameMachine: "x86_64",
      githubRunnerOs: "macOS",
      githubRunnerArch: "X64",
      rustHost: "x86_64-apple-darwin",
    },
  );
  assert.equal(errors.length, 5);
  assert.match(errors.join("\n"), /Node architecture/);
  assert.match(errors.join("\n"), /OS machine architecture/);
  assert.match(errors.join("\n"), /uname machine architecture/);
  assert.match(errors.join("\n"), /GitHub runner architecture/);
  assert.match(errors.join("\n"), /Rust host target/);
});

test("build environment rejects missing or unsupported manifest runner declarations", () => {
  assert.throws(() => buildEnvironmentMismatches("target", null, {}), /manifest 缺少/);
  assert.throws(
    () => buildEnvironmentMismatches("target", { os: "freebsd", arch: "x64" }, {}),
    /不受支持/,
  );
});
