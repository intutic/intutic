// Checksum-verification tests for the npm launcher (proxy.js).
//
// proxy.js has no build step and no other devDependencies — it is deliberately
// a thin, dependency-free launcher (see its own module doc). Node's built-in
// test runner covers it without adding a test framework the package would
// otherwise never need. Run with `node --test bin/proxy.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { sha256Hex, parseChecksums, verifyChecksum, resolveAssetName } from './proxy.js';

function realSha256Hex(buffer) {
  return 'sha256:' + crypto.createHash('sha256').update(buffer).digest('hex');
}

test('sha256Hex matches a hand-computed digest', () => {
  const buf = Buffer.from('intutic-proxy fixture bytes');
  assert.equal(sha256Hex(buf), realSha256Hex(buf));
});

test('sha256Hex is sensitive to a single byte', () => {
  const a = Buffer.from('same except one byte: a');
  const b = Buffer.from('same except one byte: b');
  assert.notEqual(sha256Hex(a), sha256Hex(b));
});

test('parseChecksums accepts a well-formed object', () => {
  const parsed = parseChecksums('{"intutic-proxy-darwin-arm64":"sha256:abc"}');
  assert.deepEqual(parsed, { 'intutic-proxy-darwin-arm64': 'sha256:abc' });
});

for (const bad of ['[1,2,3]', 'null', '"just a string"', '42', 'not json at all']) {
  test(`parseChecksums rejects ${JSON.stringify(bad)}`, () => {
    assert.throws(() => parseChecksums(bad));
  });
}

test('verifyChecksum passes when the digest matches', () => {
  const buf = Buffer.from('a real, unmodified release binary');
  const checksums = { 'intutic-proxy-linux-x64': sha256Hex(buf) };
  assert.doesNotThrow(() => verifyChecksum(buf, checksums, 'intutic-proxy-linux-x64'));
});

test('verifyChecksum refuses a tampered binary — one flipped byte', () => {
  const original = Buffer.from('a real, unmodified release binary');
  const checksums = { 'intutic-proxy-linux-x64': sha256Hex(original) };

  const tampered = Buffer.from(original);
  tampered[0] ^= 0xff; // flip a single byte, simulating a swapped/corrupted asset

  assert.throws(
    () => verifyChecksum(tampered, checksums, 'intutic-proxy-linux-x64'),
    /Checksum mismatch/,
  );
});

test('verifyChecksum refuses an asset absent from the manifest, not silently allows it', () => {
  const buf = Buffer.from('binary for an asset checksums.json forgot to list');
  const checksums = { 'intutic-proxy-darwin-arm64': sha256Hex(Buffer.from('a different asset')) };
  assert.throws(
    () => verifyChecksum(buf, checksums, 'intutic-proxy-linux-x64'),
    /no entry for intutic-proxy-linux-x64/,
  );
});

test('verifyChecksum refuses against an empty manifest', () => {
  const buf = Buffer.from('anything');
  assert.throws(() => verifyChecksum(buf, {}, 'intutic-proxy-win32-x64.exe'));
});

// resolveAssetName: every value here MUST match a real .github/workflows/publish.yml
// build-rust-proxy matrix artifact_name, and every one below has a live release asset
// verified against it (`gh release view` on v1.6.0 through the current release found
// exactly these five names). A naming mismatch here means real installed launchers
// 404 on download — this repo shipped that exact bug (intutic-proxy-linux-x64 vs. the
// matrix's then-artifact_name intutic-proxy-linux-amd64, and no Linux arm64 target at
// all, despite every real release having shipped one since v1.6.0).
const SUPPORTED_PLATFORMS = [
  ['darwin', 'arm64', 'intutic-proxy-darwin-arm64'],
  ['darwin', 'x64', 'intutic-proxy-darwin-x64'],
  ['linux', 'x64', 'intutic-proxy-linux-x64'],
  ['linux', 'arm64', 'intutic-proxy-linux-arm64'],
  ['win32', 'x64', 'intutic-proxy-win32-x64.exe'],
];

for (const [platform, arch, expected] of SUPPORTED_PLATFORMS) {
  test(`resolveAssetName(${platform}, ${arch}) resolves to ${expected}`, () => {
    assert.equal(resolveAssetName(platform, arch), expected);
  });
}

const UNSUPPORTED_PLATFORMS = [
  ['darwin', 'ia32'],
  ['linux', 'ia32'],
  ['win32', 'arm64'],
  ['win32', 'ia32'],
  ['freebsd', 'x64'],
  ['sunos', 'x64'],
];

for (const [platform, arch] of UNSUPPORTED_PLATFORMS) {
  test(`resolveAssetName(${platform}, ${arch}) returns null — no asset exists for this combination`, () => {
    assert.equal(resolveAssetName(platform, arch), null);
  });
}

test('resolveAssetName defaults to the real process.platform/process.arch when called with no arguments', () => {
  assert.equal(resolveAssetName(), resolveAssetName(process.platform, process.arch));
});
