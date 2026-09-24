import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HEIF_MARKER_NAME,
  heifCandidateProvenance,
  heifProvenanceMatches,
  verifyHeifCache,
} from "./heif-contract.mjs";

const fixtureStaticLibrary = "static library";
const fixtureStaticLibrarySha256 = createHash("sha256").update(fixtureStaticLibrary).digest("hex");
const fixture = {
  schemaVersion: 1,
  release: { version: "26.7.0", releaseUrl: "https://example.invalid/release" },
  libraries: [{
    name: "libheif", version: "1.23.1", license: "LGPL-3.0-or-later",
    repositoryUrl: "https://example.invalid/libheif", sourceCommit: "a".repeat(40),
    sourceUrl: "https://example.invalid/source", licenseUrl: "https://example.invalid/COPYING",
    licenseFileName: "libheif-COPYING", licenseSha256: "b".repeat(64),
  }],
  targets: {
    "x86_64-pc-windows-msvc": {
      runner: { os: "win32", arch: "x64" }, assetName: "static_windows_x64.zip",
      assetUrl: "https://example.invalid/heif.zip", assetSha256: "c".repeat(64),
      assetSizeBytes: 123, staticLibraries: ["heif.lib"],
      staticLibrarySha256s: { "heif.lib": fixtureStaticLibrarySha256 },
    },
  },
  headerChecks: { "include/libheif/heif_version.h": "LIBHEIF_VERSION \"1.23.1\"" },
};
const clone = (value) => JSON.parse(JSON.stringify(value));

test("HEIF candidate provenance binds archive, target, source commits, and license digests", () => {
  const provenance = heifCandidateProvenance(fixture, "x86_64-pc-windows-msvc");
  assert.deepEqual(provenance.staticLibrarySha256s, fixture.targets["x86_64-pc-windows-msvc"].staticLibrarySha256s);
  assert.equal(heifProvenanceMatches(provenance, clone(provenance)), true);
  assert.equal(heifProvenanceMatches(provenance, { ...provenance, target: "aarch64-apple-darwin" }), false);
  assert.equal(
    heifProvenanceMatches(provenance, {
      ...provenance,
      libraries: [{ ...provenance.libraries[0], licenseSha256: "d".repeat(64) }],
    }),
    false,
  );
});

test("HEIF cache requires pinned archive and per-library digests, version headers, and licenses", () => {
  const temp = mkdtempSync(join(tmpdir(), "bagertea-heif-contract-"));
  try {
    const cache = join(temp, "cache");
    mkdirSync(join(cache, "include", "libheif"), { recursive: true });
    mkdirSync(join(cache, "lib"), { recursive: true });
    mkdirSync(join(cache, "licenses"), { recursive: true });
    writeFileSync(join(cache, "include", "libheif", "heif_version.h"), "LIBHEIF_VERSION \"1.23.1\"\n");
    writeFileSync(join(cache, "lib", "heif.lib"), fixtureStaticLibrary);
    writeFileSync(join(cache, "licenses", "libheif-COPYING"), "license text");
    const cacheFixture = clone(fixture);
    cacheFixture.libraries[0].licenseSha256 = createHash("sha256").update("license text").digest("hex");
    const marker = {
      schemaVersion: 2,
      target: "x86_64-pc-windows-msvc",
      releaseVersion: "26.7.0",
      assetName: "static_windows_x64.zip",
      assetSha256: "c".repeat(64),
      assetSizeBytes: 123,
      staticLibrarySha256s: { "heif.lib": fixtureStaticLibrarySha256 },
    };
    writeFileSync(join(cache, HEIF_MARKER_NAME), JSON.stringify(marker));
    assert.equal(verifyHeifCache(cache, cacheFixture, "x86_64-pc-windows-msvc").ok, true);
    marker.staticLibrarySha256s["heif.lib"] = "d".repeat(64);
    writeFileSync(join(cache, HEIF_MARKER_NAME), JSON.stringify(marker));
    assert.match(verifyHeifCache(cache, cacheFixture, "x86_64-pc-windows-msvc").reason, /与固定 manifest 不一致/);
    marker.staticLibrarySha256s["heif.lib"] = fixtureStaticLibrarySha256;
    writeFileSync(join(cache, HEIF_MARKER_NAME), JSON.stringify(marker));
    writeFileSync(join(cache, "lib", "heif.lib"), "tampered library");
    assert.match(verifyHeifCache(cache, cacheFixture, "x86_64-pc-windows-msvc").reason, /SHA256 不匹配/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("HEIF cache recognizes old metadata only as a migration candidate", () => {
  const temp = mkdtempSync(join(tmpdir(), "bagertea-heif-legacy-"));
  try {
    const cache = join(temp, "cache");
    mkdirSync(join(cache, "include", "libheif"), { recursive: true });
    mkdirSync(join(cache, "lib"), { recursive: true });
    mkdirSync(join(cache, "licenses"), { recursive: true });
    writeFileSync(join(cache, "include", "libheif", "heif_version.h"), "LIBHEIF_VERSION \"1.23.1\"\n");
    writeFileSync(join(cache, "lib", "heif.lib"), fixtureStaticLibrary);
    writeFileSync(join(cache, "licenses", "libheif-COPYING"), "license text");
    const cacheFixture = clone(fixture);
    cacheFixture.libraries[0].licenseSha256 = createHash("sha256").update("license text").digest("hex");
    writeFileSync(join(cache, ".bagertea-heif-verified.json"), JSON.stringify({
      schemaVersion: 1,
      target: "x86_64-pc-windows-msvc",
      releaseVersion: "26.7.0",
      assetName: "static_windows_x64.zip",
      assetSha256: "c".repeat(64),
      assetSizeBytes: 123,
    }));
    const result = verifyHeifCache(cache, cacheFixture, "x86_64-pc-windows-msvc");
    assert.equal(result.ok, true);
    assert.equal(result.legacy, true);
    writeFileSync(join(cache, "lib", "heif.lib"), "unverified legacy library");
    assert.match(verifyHeifCache(cache, cacheFixture, "x86_64-pc-windows-msvc").reason, /SHA256 不匹配/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
