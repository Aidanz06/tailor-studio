#!/usr/bin/env node
/*
 * Shoot ingestion helper — turns a folder of photos into scaffolded eval
 * fixtures, so adding the next labeled shoot is one command:
 *
 *   node pipeline/eval/ingest-shoot.js <photo-folder> --name=<shoot-name> [--copy-max-edge=1568]
 *
 * What it does:
 *   1. Reads EXIF DateTimeOriginal from every photo (the decisive grouping
 *      signal) and reports it per file. Photos WITHOUT EXIF are flagged loudly
 *      — re-exports/screenshots strip it, and a shoot with no capture times can
 *      only test vision-only grouping (a different, harder regime).
 *   2. Copies the photos into grailed-vision-test/<shoot-name>/, downscaled to
 *      --copy-max-edge (default 1568 px — exactly what the API sees anyway;
 *      keeps the repo small). EXIF-less sources lose nothing in the resize;
 *      sources WITH EXIF are copied at full bytes to preserve the metadata.
 *   3. Groups photos into bursts by EXIF gap (>3 min = new burst; filename
 *      order when EXIF is absent) and scaffolds
 *      grailed-vision-test/ground-truth.<shoot-name>.json with one placeholder
 *      item per burst and per-photo entries for YOU to verify/fill in.
 *   4. Prints the follow-up steps (label items, optionally add identification/
 *      comp fixtures for items in the shoot).
 *
 * Everything dropped or degraded is log()ged — no silent truncation.
 * The scaffold marks itself "verified": false until you edit the labels.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { readExifDateTimeOriginal } = require('../groupingStrategy');

const REPO = path.resolve(__dirname, '..', '..');
const OUT_ROOT = path.join(REPO, 'grailed-vision-test');
const IMG_RE = /\.(jpe?g|png|webp)$/i;
const BURST_GAP_S = 180;

const args = process.argv.slice(2);
const folder = args.find((a) => !a.startsWith('--'));
const val = (k, d) => { const a = args.find((x) => x.startsWith(k + '=')); return a ? a.split('=')[1] : d; };
const name = val('--name', folder ? path.basename(path.resolve(folder)).toLowerCase().replace(/[^a-z0-9]+/g, '-') : null);
const copyMaxEdge = Number(val('--copy-max-edge', 1568));

function log(msg) { console.log(msg); }

function main() {
  if (!folder || !name) {
    console.error('Usage: node pipeline/eval/ingest-shoot.js <photo-folder> --name=<shoot-name> [--copy-max-edge=1568]');
    process.exit(2);
  }
  const src = path.resolve(folder);
  if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) {
    console.error(`Not a directory: ${src}`);
    process.exit(2);
  }

  const all = fs.readdirSync(src).sort();
  const dropped = [];
  const files = all.filter((f) => {
    if (f.startsWith('.')) { return false; }
    if (!IMG_RE.test(f)) { dropped.push(f); return false; }
    return true;
  });
  for (const d of dropped) log(`[drop] ${d} — unsupported type (only jpg/jpeg/png/webp are ingested)`);
  if (!files.length) { console.error('No usable photos found.'); process.exit(2); }

  // 1. EXIF audit.
  const rows = files.map((f) => {
    const ms = readExifDateTimeOriginal(path.join(src, f));
    return { f, ms };
  });
  const noExif = rows.filter((r) => r.ms == null);
  for (const r of rows) {
    log(`[exif] ${r.f.padEnd(20)} ${r.ms ? new Date(r.ms).toISOString() : 'MISSING DateTimeOriginal'}`);
  }
  const exifAbsent = noExif.length === rows.length;
  if (noExif.length) {
    log(`\n[flag] ${noExif.length}/${rows.length} photo(s) have NO EXIF DateTimeOriginal.`);
    if (exifAbsent) {
      log('[flag] The WHOLE shoot lost EXIF (re-export/screenshot?). Keeping all photos, but this');
      log('[flag] shoot can only measure VISION-ONLY grouping — the time prior is unavailable.');
      log('[flag] If you still have the originals (e.g. AirDrop from the phone), re-ingest those instead.');
    } else {
      log('[flag] Mixed EXIF: the time prior will only apply between photos that kept it.');
    }
  }

  // 2. Copy into the repo (downscaled unless the source carries EXIF we must keep).
  const destDir = path.join(OUT_ROOT, name);
  fs.mkdirSync(destDir, { recursive: true });
  for (const r of rows) {
    const from = path.join(src, r.f);
    const to = path.join(destDir, r.f);
    if (r.ms != null) {
      fs.copyFileSync(from, to); // keep original bytes — the EXIF is the signal
    } else {
      try {
        execFileSync('sips', ['-Z', String(copyMaxEdge), '-s', 'format', 'jpeg', '-s', 'formatOptions', '85', from, '--out', to], { stdio: 'ignore' });
      } catch {
        fs.copyFileSync(from, to);
        log(`[warn] ${r.f}: sips unavailable — copied at full size`);
      }
    }
  }
  log(`\n[copy] ${rows.length} photo(s) → ${path.relative(REPO, destDir)}${exifAbsent ? ` (downscaled to ${copyMaxEdge}px — no EXIF to preserve)` : ''}`);

  // 3. Burst-scaffold the ground truth.
  const sorted = [...rows].sort((a, b) => (a.ms ?? Infinity) - (b.ms ?? Infinity) || a.f.localeCompare(b.f));
  const bursts = [];
  let cur = null;
  let prevMs = null;
  for (const r of sorted) {
    // Split only on a REAL time gap; EXIF-less photos stay in the current burst
    // (filename order) — with no time signal a split would be arbitrary.
    const newBurst = !cur || (r.ms != null && prevMs != null && (r.ms - prevMs) / 1000 > BURST_GAP_S);
    if (newBurst) { cur = []; bursts.push(cur); }
    cur.push(r);
    if (r.ms != null) prevMs = r.ms;
  }
  if (exifAbsent) log('[scaffold] no EXIF → single filename-ordered burst; item boundaries are YOURS to draw.');
  else log(`[scaffold] ${bursts.length} EXIF burst(s) (> ${BURST_GAP_S}s gap = new burst) — one placeholder item each.`);

  const items = {};
  const photos = [];
  bursts.forEach((b, i) => {
    const id = `item_${i + 1}`;
    items[id] = { name: `TODO — label this item (burst ${i + 1}: ${b[0].f} … ${b[b.length - 1].f})`, description: 'TODO' };
    for (const r of b) {
      photos.push({
        path: path.join('grailed-vision-test', name, r.f).split(path.sep).join('/'),
        item: id,
        view: 'TODO',
        datetime_original: r.ms ? new Date(r.ms).toISOString() : null,
        desc: 'TODO',
      });
    }
  });

  const gtFile = path.join(OUT_ROOT, `ground-truth.${name}.json`);
  if (fs.existsSync(gtFile)) {
    log(`[skip] ${path.relative(REPO, gtFile)} already exists — NOT overwriting your labels.`);
  } else {
    fs.writeFileSync(gtFile, JSON.stringify({
      _comment: `Scaffolded by ingest-shoot.js from ${src} — VERIFY every item/photo label before trusting harness numbers.`,
      verified: false,
      labeledOn: new Date().toISOString().slice(0, 10),
      method: exifAbsent ? 'SCAFFOLD ONLY — no EXIF; label by visual inspection' : 'SCAFFOLD from EXIF bursts — verify by visual inspection',
      exif: exifAbsent ? 'absent (vision-only shoot)' : (noExif.length ? 'partial' : 'present'),
      items, photos,
    }, null, 2) + '\n');
    log(`[write] ${path.relative(REPO, gtFile)}`);
  }

  log('\nNext steps:');
  log(`  1. Edit ${path.relative(REPO, gtFile)} — set each photo's real item + desc, name the items, set "verified": true.`);
  log(`  2. Score grouping:  node pipeline/harness.js --live --gt=${path.relative(REPO, gtFile)}`);
  log('  3. Per item worth an attributes case: mkdir pipeline/fixtures/identification/<case>, copy its photos, write expected.json.');
  log('  4. If you know a REAL sold listing for an item (url + price): add pipeline/fixtures/comps/<case>.json.');
}

main();
