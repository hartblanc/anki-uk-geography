#!/usr/bin/env node
// Verifies a downloaded raw data file against its pinned sha256 in
// src/data/raw_source_checksums.json, or (with --pin) records the file's
// current hash as the new pinned value. Used by the Makefile's raw data
// fetch recipes so an unannounced change in an upstream dataset fails the
// build with a clear diff instead of silently flowing into mapshaper.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO_ROOT = path.join(__dirname, '..', '..');
const MANIFEST_PATH = path.join(REPO_ROOT, 'src', 'data', 'raw_source_checksums.json');

// Some WFS/ArcGIS endpoints stamp every response with a request-time field
// that has nothing to do with the actual data (e.g. GeoServer's WFS
// `timeStamp`), so it must be stripped before hashing or every re-fetch
// would "drift" even with byte-identical underlying data.
const VOLATILE_JSON_KEYS = new Set(['timeStamp']);

function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object') {
    const sorted = {};
    for (const k of Object.keys(value).sort()) {
      if (VOLATILE_JSON_KEYS.has(k)) continue;
      sorted[k] = sortKeysDeep(value[k]);
    }
    return sorted;
  }
  return value;
}

// JSON sources (geojson/topojson) are canonicalized before hashing, so
// incidental whitespace/key-order/volatile-field differences from the
// server don't register as data changes. Non-JSON sources (e.g. zips) are
// hashed as raw bytes.
function canonicalBytes(filePath) {
  const raw = fs.readFileSync(filePath);
  try {
    return Buffer.from(JSON.stringify(sortKeysDeep(JSON.parse(raw.toString('utf8')))));
  } catch {
    return raw;
  }
}

const args = process.argv.slice(2);
const pin = args.includes('--pin');
const file = args.find((a) => !a.startsWith('--'));
if (!file) {
  console.error('Usage: verify_checksum.js <file> [--pin]');
  process.exit(2);
}

const manifest = fs.existsSync(MANIFEST_PATH)
  ? JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'))
  : {};

const key = path.relative(REPO_ROOT, path.resolve(file)).split(path.sep).join('/');
const actual = crypto.createHash('sha256').update(canonicalBytes(file)).digest('hex');
const scriptRel = path.relative(process.cwd(), __filename);

if (pin) {
  manifest[key] = actual;
  const sorted = Object.fromEntries(Object.keys(manifest).sort().map((k) => [k, manifest[k]]));
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(sorted, null, 2) + '\n');
  console.log(`Pinned ${key}: ${actual}`);
  process.exit(0);
}

const expected = manifest[key];
if (!expected) {
  console.error(
    `No pinned checksum for ${key} (sha256 ${actual}).\n` +
    `If this is a new source, pin it with: node ${scriptRel} ${file} --pin`
  );
  process.exit(1);
}
if (actual !== expected) {
  console.error(
    `Checksum mismatch for ${key}:\n  expected ${expected}\n  got      ${actual}\n` +
    `The upstream data has changed. Inspect the new data, then accept it with:\n` +
    `  node ${scriptRel} ${file} --pin`
  );
  process.exit(1);
}
console.log(`${key}: checksum OK`);
