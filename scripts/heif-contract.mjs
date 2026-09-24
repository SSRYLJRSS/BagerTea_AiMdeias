import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const HEIF_MARKER_NAME = ".bagertea-heif-verified-v2.json";
const LEGACY_HEIF_MARKER_NAME = ".bagertea-heif-verified.json";

export function heifCandidateProvenance(manifest, target) {
  const targetMeta = manifest?.targets?.[target];
  if (!targetMeta) throw new Error(`HEIF manifest 缺少目标：${target}`);
  if (!validStaticLibraryPins(targetMeta)) throw new Error(`HEIF manifest 缺少有效静态库摘要：${target}`);
  return {
    releaseVersion: manifest.release.version,
    releaseUrl: manifest.release.releaseUrl,
    target,
    runner: targetMeta.runner,
    asset: {
      name: targetMeta.assetName,
      url: targetMeta.assetUrl,
      sizeBytes: targetMeta.assetSizeBytes,
      sha256: targetMeta.assetSha256,
    },
    staticLibraries: targetMeta.staticLibraries,
    staticLibrarySha256s: targetMeta.staticLibrarySha256s,
    libraries: manifest.libraries.map((library) => ({
      name: library.name,
      version: library.version,
      license: library.license,
      repositoryUrl: library.repositoryUrl,
      sourceCommit: library.sourceCommit,
      sourceUrl: library.sourceUrl,
      licenseUrl: library.licenseUrl,
      licenseFileName: library.licenseFileName,
      licenseSha256: library.licenseSha256,
    })),
  };
}

function validStaticLibraryPins(targetMeta) {
  const libraries = targetMeta?.staticLibraries;
  const hashes = targetMeta?.staticLibrarySha256s;
  if (!Array.isArray(libraries) || libraries.length === 0 || !hashes || typeof hashes !== "object") return false;
  const expectedNames = [...libraries].sort();
  const pinnedNames = Object.keys(hashes).sort();
  return JSON.stringify(expectedNames) === JSON.stringify(pinnedNames) &&
    libraries.every((library) => /^[a-f0-9]{64}$/.test(hashes[library] ?? ""));
}

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function heifProvenanceMatches(expected, actual) {
  return Boolean(actual) && stableJson(expected) === stableJson(actual);
}

export function verifyHeifCache(cacheDir, manifest, target) {
  const targetMeta = manifest?.targets?.[target];
  if (!targetMeta) return { ok: false, reason: `HEIF manifest 缺少目标：${target}` };
  if (!validStaticLibraryPins(targetMeta)) return { ok: false, reason: "HEIF manifest 缺少有效静态库摘要清单" };

  try {
    if (!existsSync(join(cacheDir, "include")) || !existsSync(join(cacheDir, "lib"))) {
      return { ok: false, reason: "缺少 include/ 或 lib/" };
    }
    const currentMarkerPath = join(cacheDir, HEIF_MARKER_NAME);
    const legacyMarkerPath = join(cacheDir, LEGACY_HEIF_MARKER_NAME);
    const legacy = !existsSync(currentMarkerPath) && existsSync(legacyMarkerPath);
    const markerPath = legacy ? legacyMarkerPath : currentMarkerPath;
    const marker = JSON.parse(readFileSync(markerPath, "utf8"));
    if (
      marker.schemaVersion !== (legacy ? 1 : 2) || marker.target !== target ||
      marker.releaseVersion !== manifest.release.version ||
      marker.assetName !== targetMeta.assetName ||
      marker.assetSha256 !== targetMeta.assetSha256 ||
      marker.assetSizeBytes !== targetMeta.assetSizeBytes
    ) return { ok: false, reason: "本机验证标记与固定 manifest 不匹配" };

    const recordedLibraryHashes = marker.staticLibrarySha256s;
    if (!legacy && stableJson(recordedLibraryHashes) !== stableJson(targetMeta.staticLibrarySha256s)) {
      return { ok: false, reason: "缓存静态库摘要与固定 manifest 不一致" };
    }
    const actualLibraryNames = [];
    for (const library of targetMeta.staticLibraries) {
      const path = join(cacheDir, "lib", library);
      if (!existsSync(path) || !statSync(path).isFile() || statSync(path).size === 0) {
        return { ok: false, reason: `缺少静态库：${library}` };
      }
      actualLibraryNames.push(library);
      const expectedHash = targetMeta.staticLibrarySha256s[library];
      const actualHash = createHash("sha256").update(readFileSync(path)).digest("hex");
      if (actualHash !== expectedHash) {
        return { ok: false, reason: `静态库 SHA256 不匹配：${library}` };
      }
    }
    if (JSON.stringify(Object.keys(recordedLibraryHashes ?? {}).sort()) !== JSON.stringify(actualLibraryNames.sort()) && !legacy) {
      return { ok: false, reason: "静态库摘要清单与目标 manifest 不一致" };
    }
    for (const [relativePath, expectedText] of Object.entries(manifest.headerChecks ?? {})) {
      const path = join(cacheDir, ...relativePath.split("/"));
      if (!existsSync(path) || !readFileSync(path, "utf8").includes(expectedText)) {
        return { ok: false, reason: `头文件版本不匹配：${relativePath}` };
      }
    }
    for (const library of manifest.libraries ?? []) {
      const licensePath = join(cacheDir, "licenses", library.licenseFileName);
      if (!existsSync(licensePath) || !statSync(licensePath).isFile()) {
        return { ok: false, reason: `许可证材料缺失：${library.licenseFileName}` };
      }
      const digest = createHash("sha256").update(readFileSync(licensePath)).digest("hex");
      if (digest !== library.licenseSha256) {
        return { ok: false, reason: `许可证摘要不匹配：${library.licenseFileName}` };
      }
    }
    return { ok: true, marker, legacy };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
