#!/usr/bin/env node
/* global process, console, fetch, AbortSignal, Buffer */
/** Fetch target-specific FFmpeg sidecars only from the pinned manifest and verify every digest. */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const binDir = join(root, "src-tauri", "binaries");
const manifest = JSON.parse(readFileSync(join(binDir, "manifest.json"), "utf8"));
const targetArg = process.argv.indexOf("--target");
const target = targetArg >= 0 ? process.argv[targetArg + 1] : null;
const meta = target && manifest.targets?.[target];
if (!meta) {
  console.error("请指定 manifest 中的 target，例如 --target x86_64-pc-windows-msvc");
  process.exit(1);
}
if (!meta.runner || process.platform !== meta.runner.os || process.arch !== meta.runner.arch) {
  throw new Error(
    `媒体 sidecar 必须在原生 runner 准备：${target} 需要 ${meta.runner?.os ?? "?"}/${meta.runner?.arch ?? "?"}，当前 ${process.platform}/${process.arch}`,
  );
}

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const isSafeRelative = (value) => {
  if (typeof value !== "string" || !value || value.includes("\0")) return false;
  const normalized = value.replaceAll("\\", "/");
  return !normalized.startsWith("/") && !normalized.includes(":") && !normalized.split("/").includes("..");
};
const run = (command, args) => {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} 失败：${result.error?.message ?? result.status ?? "signal"}`);
  }
};
const capture = (command, args) => {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} 失败：${result.error?.message ?? result.status ?? "signal"}`);
  }
  return result.stdout ?? "";
};

async function download(url, expected) {
  if (!/^https:\/\//i.test(url ?? "") || /\/latest(?:\/|$)/i.test(url)) {
    throw new Error(`来源必须是固定版本 HTTPS URL：${url}`);
  }
  if (!/^[a-f0-9]{64}$/i.test(expected ?? "")) throw new Error(`SHA256 未锁定：${url}`);
  const response = await fetch(url, { signal: AbortSignal.timeout(300_000) });
  if (!response.ok) throw new Error(`下载失败 ${response.status}：${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (hash(bytes) !== expected) throw new Error(`归档 SHA256 不匹配：${url}`);
  return bytes;
}

function validateArchive(archive, kind) {
  const isZip = kind === "zip";
  const windowsZip = isZip && process.platform === "win32";
  const list = isZip
    ? (windowsZip ? capture("tar", ["-tf", archive]) : capture("unzip", ["-Z1", archive]))
    : capture("tar", ["-tf", archive]);
  const entries = list.split(/\r?\n/).filter(Boolean);
  if (entries.length === 0) throw new Error(`归档为空：${archive}`);
  for (const entry of entries) {
    if (!isSafeRelative(entry)) throw new Error(`归档路径不安全：${entry}`);
  }

  // 拒绝链接与特殊文件；这样解压过程只能创建普通文件和目录。
  const details = isZip
    ? (windowsZip ? capture("tar", ["-tvf", archive]) : capture("unzip", ["-Z", "-v", archive]))
    : capture("tar", ["-tvf", archive]);
  if (isZip && !windowsZip) {
    const blocks = details.split(/Central directory entry #\d+:\s*/).slice(1);
    for (const block of blocks) {
      const mode = block.match(/Unix file attributes \((\d+) octal\)/i)?.[1];
      if (mode) {
        const type = Number.parseInt(mode, 8) & 0o170000;
        if (![0, 0o100000, 0o040000].includes(type)) throw new Error("ZIP 归档包含链接或特殊文件");
      }
    }
  } else {
    for (const line of details.split(/\r?\n/).filter(Boolean)) {
      if (line[0] !== "-" && line[0] !== "d") throw new Error(`归档包含链接或特殊文件：${line}`);
    }
  }
}

function extract(archive, kind, destination) {
  mkdirSync(destination, { recursive: true });
  validateArchive(archive, kind);
  if (kind === "tar.xz") run("tar", ["-xJf", archive, "-C", destination]);
  else if (process.platform === "win32") run("tar", ["-xf", archive, "-C", destination]);
  else run("unzip", ["-q", archive, "-d", destination]);
}

function locate(rootDir, relative) {
  if (!isSafeRelative(relative)) throw new Error(`manifest 路径不安全：${relative}`);
  const base = resolve(rootDir);
  const candidate = resolve(base, relative);
  if (!candidate.startsWith(`${base}${sep}`) && candidate !== base) throw new Error(`manifest 路径越界：${relative}`);
  if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;

  const matches = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const item = join(directory, entry.name);
      if (entry.isDirectory()) visit(item);
      else if (entry.isFile() && entry.name === relative.split("/").at(-1)) matches.push(item.slice(rootDir.length + 1));
    }
  };
  visit(rootDir);
  const hint = matches.length ? `；归档同名条目：${matches.slice(0, 8).join(", ")}` : "";
  throw new Error(`归档内缺少文件：${relative}${hint}`);
}

async function main() {
  const temp = mkdtempSync(join(tmpdir(), "bagertea-media-tools-"));
  try {
    const archiveFor = (name) => meta[`${name}ArchiveUrl`] ?? meta.archiveUrl;
    const archiveHashFor = (name) => meta[`${name}ArchiveSha256`] ?? meta.archiveSha256;
    const kindFor = (name) => meta[`${name}ArchiveKind`] ?? meta.archiveKind;
    const pathFor = (name) => meta[`${name}PathInArchive`];
    const ext = meta.exeExt ?? "";
    const archives = new Map();
    const extractedDirs = new Map();
    const licenseName = meta.licenseFileName ?? "LICENSE.txt";
    if (!isSafeRelative(licenseName) || licenseName.includes("/")) throw new Error(`许可证文件名不安全：${licenseName}`);

    async function getArchive(name) {
      const url = archiveFor(name);
      const kind = kindFor(name);
      const expected = archiveHashFor(name);
      if (!url || !kind || !expected) throw new Error(`manifest 缺少 ${name} 归档信息`);
      if (!(["zip", "tar.xz"].includes(kind))) throw new Error(`不支持归档格式：${kind}`);
      let archive = archives.get(url);
      if (!archive) {
        archive = join(temp, `archive-${archives.size}.${kind}`);
        writeFileSync(archive, await download(url, expected));
        archives.set(url, archive);
      }
      return { archive, url, kind };
    }

    async function getExtracted(name) {
      const { archive, url, kind } = await getArchive(name);
      let extracted = extractedDirs.get(url);
      if (!extracted) {
        extracted = join(temp, `extract-${extractedDirs.size}`);
        extract(archive, kind, extracted);
        extractedDirs.set(url, extracted);
      }
      return extracted;
    }

    for (const name of ["ffmpeg", "ffprobe"]) {
      const output = join(binDir, `${name}-${target}${ext}`);
      const expected = meta[`${name}Sha256`];
      if (!/^[a-f0-9]{64}$/i.test(expected ?? "")) throw new Error(`manifest 中 ${name} SHA256 无效`);
      if (existsSync(output) && hash(readFileSync(output)) === expected) {
        if (process.platform !== "win32") chmodSync(output, 0o755);
        continue;
      }
      const extracted = await getExtracted(name);
      const source = locate(extracted, pathFor(name));
      const bytes = readFileSync(source);
      if (hash(bytes) !== expected) throw new Error(`${name} 二进制 SHA256 不匹配`);
      writeFileSync(output, bytes, { mode: 0o755 });
      if (process.platform !== "win32") chmodSync(output, 0o755);
      console.log(`prepared ${output}`);
    }

    const licenseHash = meta.licenseSha256;
    if (!/^[a-f0-9]{64}$/i.test(licenseHash ?? "")) throw new Error("manifest 中许可证 SHA256 无效");
    const licenseDir = join(binDir, "licenses", target);
    mkdirSync(licenseDir, { recursive: true });
    const licenseOutput = join(licenseDir, licenseName);
    if (!existsSync(licenseOutput) || hash(readFileSync(licenseOutput)) !== licenseHash) {
      let licenseBytes;
      if (meta.licensePathInArchive) {
        const extracted = await getExtracted("ffmpeg");
        licenseBytes = readFileSync(locate(extracted, meta.licensePathInArchive));
      } else if (meta.licenseUrl) {
        licenseBytes = await download(meta.licenseUrl, licenseHash);
      } else throw new Error("manifest 缺少许可证来源");
      if (hash(licenseBytes) !== licenseHash) throw new Error("许可证 SHA256 不匹配");
      writeFileSync(licenseOutput, licenseBytes);
    }
    console.log(`media tools ready: ${target}`);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(`[media-tools] ${error.message}`); process.exit(1); });
