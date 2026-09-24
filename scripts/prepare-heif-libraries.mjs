#!/usr/bin/env node
/* global process, console, fetch, AbortSignal, Buffer */
/** Fetch one pinned native HEIF archive, validate it and its license texts, then populate an ignored target cache. */
import { createHash } from "node:crypto";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { HEIF_MARKER_NAME, verifyHeifCache } from "./heif-contract.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tauriDir = join(root, "src-tauri");
const cacheRoot = join(tauriDir, "native", "heif");
const manifest = JSON.parse(readFileSync(join(tauriDir, "native", "heif-manifest.json"), "utf8"));
const argIndex = process.argv.indexOf("--target");
const target = argIndex >= 0 ? process.argv[argIndex + 1] : null;
const validateOnly = process.argv.includes("--validate-only");
const targetMeta = target && manifest.targets?.[target];
if (!targetMeta) throw new Error("请指定支持的 target，例如 --target x86_64-pc-windows-msvc");
if (!validateOnly && (process.platform !== targetMeta.runner.os || process.arch !== targetMeta.runner.arch)) {
  throw new Error(`HEIF 归档必须在原生 runner 准备：${target} 需要 ${targetMeta.runner.os}/${targetMeta.runner.arch}，当前 ${process.platform}/${process.arch}`);
}

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const safeArchivePath = (value) => {
  const normalized = value.replaceAll("\\", "/");
  return Boolean(value) && !normalized.startsWith("/") && !normalized.includes(":") &&
    !normalized.split("/").includes("..") && ["include", "lib"].includes(normalized.split("/")[0]);
};
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} 失败：${result.error?.message ?? result.status ?? "signal"}`);
  }
};
const capture = (command, args) => {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} 失败：${result.error?.message ?? result.status ?? "signal"}`);
  }
  return result.stdout ?? "";
};

async function fetchPinned(url, expectedSha256, expectedSize) {
  if (!/^https:\/\//i.test(url ?? "") || /\/latest(?:\/|$)/i.test(url)) throw new Error(`来源不是固定 HTTPS URL：${url}`);
  if (!/^[a-f0-9]{64}$/.test(expectedSha256 ?? "")) throw new Error(`来源缺少固定 SHA256：${url}`);
  if (expectedSize !== null && (!Number.isSafeInteger(expectedSize) || expectedSize <= 0)) throw new Error(`来源缺少固定文件大小：${url}`);
  const response = await fetch(url, { signal: AbortSignal.timeout(300_000) });
  if (!response.ok) throw new Error(`下载失败 ${response.status}：${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (expectedSize !== null && bytes.length !== expectedSize) throw new Error(`下载大小不匹配：${url}，预期 ${expectedSize}，实际 ${bytes.length}`);
  if (hash(bytes) !== expectedSha256) throw new Error(`下载 SHA256 不匹配：${url}`);
  return bytes;
}

function inspectArchive(archivePath) {
  const windowsZip = process.platform === "win32";
  const list = windowsZip ? capture("tar", ["-tf", archivePath]) : capture("unzip", ["-Z1", archivePath]);
  const entries = list.split(/\r?\n/).filter(Boolean);
  if (entries.length === 0) throw new Error("HEIF 归档为空");
  for (const entry of entries) {
    if (!safeArchivePath(entry)) throw new Error(`HEIF 归档包含不安全或非预期路径：${entry}`);
  }

  const details = windowsZip ? capture("tar", ["-tvf", archivePath]) : capture("unzip", ["-Z", "-v", archivePath]);
  if (windowsZip) {
    for (const line of details.split(/\r?\n/).filter(Boolean)) {
      if (line[0] !== "-" && line[0] !== "d") throw new Error(`HEIF 归档包含链接或特殊文件：${line}`);
    }
  } else {
    const blocks = details.split(/Central directory entry #\d+:\s*/).slice(1);
    for (const block of blocks) {
      const mode = block.match(/Unix file attributes \((\d+) octal\)/i)?.[1];
      if (mode) {
        const type = Number.parseInt(mode, 8) & 0o170000;
        if (![0, 0o100000, 0o040000].includes(type)) throw new Error("HEIF ZIP 包含链接或特殊文件");
      }
    }
  }
}

async function main() {
  const destination = join(cacheRoot, target);
  const existing = validateOnly ? { ok: false } : verifyHeifCache(destination, manifest, target);
  if (!validateOnly && existing.ok && !existing.legacy) {
    console.log(`HEIF libraries already verified: ${destination}`);
    if (process.env.GITHUB_ENV) appendFileSync(process.env.GITHUB_ENV, `HEIF_BINARIES_DIR=${destination}\n`);
    return;
  }
  if (!validateOnly && existsSync(destination) && !(existing.ok && existing.legacy)) {
    throw new Error(`目标缓存存在但校验失败，未覆盖本机数据：${destination} (${existing.reason})`);
  }

  if (!validateOnly) mkdirSync(cacheRoot, { recursive: true });
  const temp = mkdtempSync(join(tmpdir(), "bagertea-heif-"));
  const stage = validateOnly ? join(temp, "staged") : mkdtempSync(join(cacheRoot, `.stage-${target}-`));
  if (validateOnly) mkdirSync(stage);
  try {
    const archivePath = join(temp, targetMeta.assetName);
    const bytes = await fetchPinned(targetMeta.assetUrl, targetMeta.assetSha256, targetMeta.assetSizeBytes);
    writeFileSync(archivePath, bytes, { flag: "wx" });
    inspectArchive(archivePath);
    const extracted = join(temp, "extracted");
    mkdirSync(extracted);
    if (process.platform === "win32") run("tar", ["-xf", archivePath, "-C", extracted]);
    else run("unzip", ["-q", archivePath, "-d", extracted]);

    for (const required of ["include", "lib"]) {
      const source = join(extracted, required);
      if (!existsSync(source) || !statSync(source).isDirectory()) throw new Error(`归档缺少 ${required}/`);
      cpSync(source, join(stage, required), { recursive: true, errorOnExist: true, force: false });
    }
    const licensesDir = join(stage, "licenses");
    mkdirSync(licensesDir);
    for (const library of manifest.libraries) {
      const licenseBytes = await fetchPinned(library.licenseUrl, library.licenseSha256, null);
      writeFileSync(join(licensesDir, library.licenseFileName), licenseBytes, { flag: "wx" });
    }

    for (const [relativePath, expectedText] of Object.entries(manifest.headerChecks ?? {})) {
      const header = join(stage, ...relativePath.split("/"));
      if (!existsSync(header) || !readFileSync(header, "utf8").includes(expectedText)) {
        throw new Error(`HEIF 归档头文件版本不匹配：${relativePath}`);
      }
    }
    for (const library of targetMeta.staticLibraries) {
      const file = join(stage, "lib", library);
      if (!existsSync(file) || !statSync(file).isFile() || statSync(file).size === 0) throw new Error(`HEIF 归档缺少静态库：${library}`);
    }

    const staticLibrarySha256s = Object.fromEntries(targetMeta.staticLibraries.map((library) => [
      library,
      hash(readFileSync(join(stage, "lib", library))),
    ]));
    if (JSON.stringify(Object.keys(staticLibrarySha256s).sort()) !== JSON.stringify(Object.keys(targetMeta.staticLibrarySha256s ?? {}).sort()) ||
      targetMeta.staticLibraries.some((library) => staticLibrarySha256s[library] !== targetMeta.staticLibrarySha256s[library])) {
      throw new Error(`提取后的 HEIF 静态库与固定 manifest SHA256 不匹配：${target}`);
    }
    const marker = {
      schemaVersion: 2,
      target,
      releaseVersion: manifest.release.version,
      assetName: targetMeta.assetName,
      assetSha256: targetMeta.assetSha256,
      assetSizeBytes: targetMeta.assetSizeBytes,
      staticLibrarySha256s,
    };
    writeFileSync(join(stage, HEIF_MARKER_NAME), `${JSON.stringify(marker, null, 2)}\n`, { flag: "wx" });
    const verification = verifyHeifCache(stage, manifest, target);
    if (!verification.ok) throw new Error(`HEIF 缓存自检失败：${verification.reason}`);

    if (validateOnly) {
      console.log(JSON.stringify({ target, staticLibrarySha256s }, null, 2));
      console.log(`HEIF source/archive validated without creating a build cache: ${target} (${targetMeta.runner.os}/${targetMeta.runner.arch})`);
      return;
    }

    if (existsSync(destination) && existing.ok && existing.legacy) {
      // Upgrade only if every legacy library exactly matches the freshly SHA-verified archive.
      // Keep the old cache and v1 marker intact; append the v2 marker atomically.
      for (const library of targetMeta.staticLibraries) {
        const legacyLibrary = join(destination, "lib", library);
        if (hash(readFileSync(legacyLibrary)) !== staticLibrarySha256s[library]) {
          throw new Error(`旧缓存中的静态库与固定归档不同，未覆盖本机数据：${library}`);
        }
      }
      const markerPath = join(destination, HEIF_MARKER_NAME);
      const markerTemp = `${markerPath}.${process.pid}.tmp`;
      writeFileSync(markerTemp, `${JSON.stringify(marker, null, 2)}\n`, { flag: "wx" });
      try {
        renameSync(markerTemp, markerPath);
      } finally {
        if (existsSync(markerTemp)) rmSync(markerTemp);
      }
      const upgraded = verifyHeifCache(destination, manifest, target);
      if (!upgraded.ok || upgraded.legacy) throw new Error(`旧缓存升级后校验失败：${upgraded.reason ?? "v2 marker 缺失"}`);
      console.log(`HEIF legacy cache verified against pinned archive and upgraded: ${destination}`);
    } else if (existsSync(destination)) {
      // A concurrent preparer may have installed the same immutable cache first.
      const secondCheck = verifyHeifCache(destination, manifest, target);
      if (!secondCheck.ok) throw new Error(`目标缓存已被其他进程创建但校验失败：${destination} (${secondCheck.reason})`);
      console.log(`HEIF libraries prepared concurrently: ${destination}`);
    } else {
      // Stage and destination are siblings, so rename is atomic on this filesystem.
      try {
        renameSync(stage, destination);
      } catch (error) {
        const concurrent = verifyHeifCache(destination, manifest, target);
        if (!concurrent.ok) throw error;
        console.log(`HEIF libraries prepared concurrently: ${destination}`);
      }
    }

    if (process.env.GITHUB_ENV) appendFileSync(process.env.GITHUB_ENV, `HEIF_BINARIES_DIR=${destination}\n`);
    console.log(`HEIF libraries prepared and verified: ${destination}`);
  } finally {
    rmSync(temp, { recursive: true, force: true });
    if (existsSync(stage)) rmSync(stage, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(`[heif] ${error.message}`); process.exit(1); });
