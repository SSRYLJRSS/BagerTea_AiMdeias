#!/usr/bin/env node
/* global process, console */
/** Print auditable native-runner facts, then fail unless runner, Node and Rust host match the target. */
import { readFileSync } from "node:fs";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mediaManifest = JSON.parse(readFileSync(join(root, "src-tauri", "binaries", "manifest.json"), "utf8"));
const GITHUB_OS_BY_NODE = Object.freeze({ win32: "Windows", darwin: "macOS", linux: "Linux" });
const GITHUB_ARCH_BY_NODE = Object.freeze({ x64: "X64", arm64: "ARM64" });

function normalizeArchitecture(value) {
  if (["x64", "x86_64", "amd64"].includes(String(value).toLowerCase())) return "x64";
  if (["arm64", "aarch64"].includes(String(value).toLowerCase())) return "arm64";
  return value;
}

function capture(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} 失败：${result.error?.message ?? result.stderr ?? result.status ?? "signal"}`);
  }
  return (result.stdout ?? "").trim();
}

export function buildEnvironmentMismatches(target, runner, actual) {
  if (!runner?.os || !runner?.arch) throw new Error(`manifest 缺少 ${target} 的原生 runner 定义`);
  const expectedGithubOs = GITHUB_OS_BY_NODE[runner.os];
  const expectedGithubArch = GITHUB_ARCH_BY_NODE[runner.arch];
  if (!expectedGithubOs || !expectedGithubArch) throw new Error(`manifest runner 不受支持：${runner.os}/${runner.arch}`);

  const checks = [
    ["Node platform", runner.os, actual.nodePlatform],
    ["Node architecture", runner.arch, actual.nodeArch],
    ["OS machine architecture", runner.arch, normalizeArchitecture(actual.machine)],
    ["GitHub runner OS", expectedGithubOs, actual.githubRunnerOs],
    ["GitHub runner architecture", expectedGithubArch, actual.githubRunnerArch],
    ["Rust host target", target, actual.rustHost],
  ];
  if (actual.unameMachine) {
    checks.push(["uname machine architecture", runner.arch, normalizeArchitecture(actual.unameMachine)]);
  }
  return checks
    .filter(([, expected, observed]) => expected !== observed)
    .map(([name, expected, observed]) => `${name}: expected=${expected} actual=${observed ?? "missing"}`);
}

function osDetails() {
  const details = {
    platform: os.platform(),
    release: os.release(),
    version: typeof os.version === "function" ? os.version() : "unavailable",
    machine: typeof os.machine === "function" ? os.machine() : "unavailable",
    cpuModel: os.cpus()[0]?.model ?? "unavailable",
  };
  if (process.platform !== "win32") {
    details.uname = capture("uname", ["-a"]);
    details.unameMachine = capture("uname", ["-m"]);
    if (process.platform === "darwin") details.macosVersion = capture("sw_vers", ["-productVersion"]);
    if (process.platform === "linux") {
      const release = readFileSync("/etc/os-release", "utf8");
      details.linuxDistribution = release.split(/\r?\n/).filter((line) => /^(NAME|VERSION_ID|PRETTY_NAME)=/.test(line));
    }
  }
  return details;
}

function main() {
  const targetIndex = process.argv.indexOf("--target");
  const target = targetIndex >= 0 ? process.argv[targetIndex + 1] : null;
  const runner = target && mediaManifest.targets?.[target]?.runner;
  if (!target || !runner) throw new Error("请指定 manifest 中定义的目标：--target <triple>");

  const rustcVerbose = capture("rustc", ["-vV"]);
  const cargoVersion = capture("cargo", ["--version"]);
  const activeToolchain = capture("rustup", ["show", "active-toolchain"]);
  const rustHost = capture("rustc", ["--print", "host-tuple"]);
  const systemDetails = osDetails();
  const githubRunnerOs = process.env.RUNNER_OS ?? GITHUB_OS_BY_NODE[process.platform] ?? "missing";
  const githubRunnerArch = process.env.RUNNER_ARCH ?? GITHUB_ARCH_BY_NODE[process.arch] ?? "missing";
  const report = {
    target,
    runner: {
      githubOs: githubRunnerOs,
      githubArch: githubRunnerArch,
      nodePlatform: process.platform,
      nodeArch: process.arch,
      nodeMachine: typeof os.machine === "function" ? os.machine() : "unavailable",
      cpuModel: os.cpus()[0]?.model ?? "unavailable",
    },
    nodeVersion: process.version,
    os: systemDetails,
    rust: { activeToolchain, cargoVersion, hostTuple: rustHost, rustcVerbose },
  };

  // Print every observed fact before checking it, so a failing runner remains auditable.
  console.log(JSON.stringify(report, null, 2));
  const mismatches = buildEnvironmentMismatches(target, runner, {
    nodePlatform: process.platform,
    nodeArch: process.arch,
    machine: systemDetails.machine,
    unameMachine: systemDetails.unameMachine,
    githubRunnerOs,
    githubRunnerArch,
    rustHost,
  });
  if (mismatches.length) throw new Error(`构建 runner 与 target 不匹配：\n- ${mismatches.join("\n- ")}`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    main();
  } catch (error) {
    console.error(`[build-environment] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
