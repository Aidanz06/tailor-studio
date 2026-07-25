/*
 * GroupingStrategy provider abstraction (PRD §5.1).
 *
 * Mirrors PriceCompProvider (priceProvider.js): one interface, several swappable
 * implementations, so the batch-intake clustering method can change without
 * touching anything downstream. `cluster.js#groupBatch` picks a strategy and
 * returns the SAME stable shape it always has:
 *
 *   group(photoPaths, opts) -> { groups, features, meta }
 *     groups[]: { groupId, photos[], signature, confidence, autoAccept, flags }   ← STABLE
 *     features : per-photo artifact the strategy used (descriptors / embeddings / labels)
 *     meta     : { strategy, model, calls, usage, estCostUsd, wallMs, notes }
 *
 * Strategies implemented:
 *   - DescriptorJaccardStrategy : baseline (per-photo vision descriptor + lexical Jaccard),
 *                                 plus an "improved" mode that adds an EXIF DateTimeOriginal
 *                                 time-prior + complete-linkage agglomeration + conservative
 *                                 auto-accept.
 *   - BatchedVisionStrategy     : ONE multimodal call, model assigns a group id + confidence
 *                                 + multi-item flag per photo. (Prior favorite for accuracy.)
 *   - EmbeddingStrategy         : image embeddings -> cosine sim -> complete-linkage agglomeration,
 *                                 fused with the EXIF time-prior. Pluggable backend:
 *                                   VoyageBackend    (hosted, needs VOYAGE_API_KEY in .env.local)
 *                                   LocalClipBackend (transformers.js, runs on the Mac, no key)
 *
 * Conservative-by-design (PRD §8.9): thresholds flag MORE for review rather than fewer.
 * New API keys belong in .env.local and are read here (main/CLI only) — never in the UI.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, execSync } = require('child_process');
const Anthropic = require('@anthropic-ai/sdk');

const {
  describePhoto,
  DESCRIPTOR_SCHEMA,
  similarity: descriptorSimilarity,
  imageBlock,
  mapLimit,
  MEDIA_TYPES,
  outputConfig,
} = require('./cluster');

// Fine-grained progress hook (UI progress bar): strategies report per-photo
// prep/describe counts through opts.onProgress. A listener error must never
// become a grouping error.
function notifyProgress(opts, p) {
  if (typeof opts?.onProgress !== 'function') return;
  try { opts.onProgress(p); } catch { /* progress is best-effort */ }
}

// Optional native resizer; absent by default (not in deps). Falls back to sips/ImageMagick.
let _sharp = null;
try { _sharp = require('sharp'); } catch { /* optional */ }
function _hasCmd(c) { try { execSync(`command -v ${c}`, { stdio: 'ignore' }); return true; } catch { return false; } }

// Downscale an image to a temp JPEG so a whole shoot fits under the API request-size cap
// (15+ full-res phone photos as base64 exceed it → 413). Long edge ≤ maxEdge, quality q.
// Uses sharp if installed, else macOS `sips`, else ImageMagick. Returns the temp path.
async function downscaleToTemp(src, { maxEdge = 1024, quality = 80 } = {}) {
  const tmp = path.join(os.tmpdir(), `gs_${process.pid}_${Math.random().toString(36).slice(2)}.jpg`);
  if (_sharp) {
    await _sharp(src).rotate().resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true }).jpeg({ quality }).toFile(tmp);
    return tmp;
  }
  if (process.platform === 'darwin' && _hasCmd('sips')) {
    execFileSync('sips', ['-Z', String(maxEdge), '-s', 'format', 'jpeg', '-s', 'formatOptions', String(quality), src, '--out', tmp], { stdio: 'ignore' });
    return tmp;
  }
  for (const cmd of ['magick', 'convert']) {
    if (_hasCmd(cmd)) { execFileSync(cmd, [src, '-auto-orient', '-resize', `${maxEdge}x${maxEdge}>`, '-quality', String(quality), tmp]); return tmp; }
  }
  throw new Error('No image resizer available for batched-vision. Install one: `npm i sharp` (or ensure macOS `sips` / ImageMagick `convert`).');
}

// Format an elapsed-ms gap as a compact "+M:SS" / "+H:MM:SS" label (or "time unknown").
function fmtElapsed(ms) {
  if (ms == null) return 'time unknown';
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return h ? `+${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `+${m}:${String(ss).padStart(2, '0')}`;
}

// Downscale a whole shoot to fit under the API request-size cap, adaptively.
// Heavier/busier photos produce bigger JPEGs, so a fixed edge/quality can still 413.
// We downscale at the requested size, measure the total base64 payload, and if it's
// over `budgetBytes` we step the resolution down a ladder and retry — so ≤ maxPhotos
// photos reliably fit regardless of how detailed they are. The EXIF time-prior in the
// prompt carries the grouping signal when resolution is reduced. Returns { temps, edge, q }.
async function prepareBatchImages(photoPaths, opts = {}) {
  const { maxEdge = 1024, quality = 80, budgetBytes = 26e6, onEach } = opts;
  // Start at the requested (benchmarked) resolution; only step DOWN if the whole
  // shoot won't fit — so small/normal batches keep full quality and large/heavy
  // ones degrade gracefully. Skip fallback rungs that would upscale.
  const ladder = [[maxEdge, quality], ...[[768, 74], [576, 68], [448, 62]].filter(([e]) => e < maxEdge)];
  for (let rung = 0; rung < ladder.length; rung++) {
    const [edge, q] = ladder[rung];
    const temps = [];
    let totalB64 = 0;
    for (let i = 0; i < photoPaths.length; i++) {
      const tmp = await downscaleToTemp(photoPaths[i], { maxEdge: edge, quality: q });
      temps.push(tmp);
      totalB64 += Math.ceil((fs.statSync(tmp).size * 4) / 3); // base64 inflates ~4/3
      if (typeof onEach === 'function') { try { onEach(i + 1, photoPaths.length, edge); } catch {} }
    }
    if (totalB64 <= budgetBytes) return { temps, edge, q, totalB64 };
    for (const t of temps) { try { fs.unlinkSync(t); } catch {} } // too big at this rung — shrink further
  }
  const err = new Error(`shoot exceeds the request payload budget even at reduced resolution (${photoPaths.length} photos)`);
  err.code = 'SHOOT_TOO_LARGE';
  throw err;
}

// ----------------------------------------------------------------------------
// Tunables (conservative defaults — flag more, not less).
// ----------------------------------------------------------------------------
const DEFAULTS = {
  // Descriptor/Jaccard
  joinThreshold: 0.5, // min combined similarity to place two photos in one group
  lowConfidence: 0.6, // group mean-similarity below this → low_confidence_group flag
  autoAcceptMin: 0.7, // group confidence must be ≥ this to auto-accept (higher than lowConfidence on purpose)
  linkage: 'complete', // 'single' | 'complete' | 'average' — complete is the most conservative merger
  // EXIF time-prior
  timeGapS: 180, // shots within this gap are treated as the same "burst"
  visualWeight: 0.6, // descriptor mode: weight of visual vs EXIF-time in the convex fusion
  timeAlpha: 0.35, // weight of the time-prior when FUSED with a [0,1] visual score (embedding mode)
  timeHalfLifeS: 150, // exponential decay half-life for the time-adjacency kernel
  // Embedding
  cosineJoin: 0.85, // cosine similarity threshold to join (tune per encoder on labeled shoots)
};

// Published per-MTok rates (USD). Override via env; see docs/clustering-methods-research.md.
// Opus 4.8 $5/$25, Haiku 4.5 $1/$5 (metacto/cloudzero, 2026-07). Image tokens ≈ (w*h)/750.
const PRICES = {
  'claude-opus-4-8': { in: 5.0, out: 25.0 },
  // List price ($2/$10 intro through 2026-08-31 — we cost at list to be conservative).
  'claude-sonnet-5': { in: 3.0, out: 15.0 },
  'claude-sonnet-4-6': { in: 3.0, out: 15.0 },
  'claude-haiku-4-5-20251001': { in: 1.0, out: 5.0 },
  'claude-haiku-4-5': { in: 1.0, out: 5.0 },
};
function priceFor(model) {
  return PRICES[model] || PRICES[String(model || '').replace(/-\d{8}$/, '')] || { in: 5.0, out: 25.0 };
}
function usdFromUsage(usage, model) {
  const p = priceFor(model);
  const inTok = (usage && (usage.input_tokens || 0)) || 0;
  const outTok = (usage && (usage.output_tokens || 0)) || 0;
  // Prompt-cache accounting: writes bill ~1.25× input, reads ~0.1× input.
  const cacheWrite = (usage && (usage.cache_creation_input_tokens || 0)) || 0;
  const cacheRead = (usage && (usage.cache_read_input_tokens || 0)) || 0;
  return ((inTok + 1.25 * cacheWrite + 0.1 * cacheRead) / 1e6) * p.in + (outTok / 1e6) * p.out;
}

// ----------------------------------------------------------------------------
// EXIF DateTimeOriginal reader — dependency-free JPEG parser.
// mtime is unreliable (copy/export/download all reset it); DateTimeOriginal is
// written once by the camera and rides inside the file. Returns epoch ms or null.
// Parses the APP1 "Exif\0\0" segment → TIFF header → IFD0 → ExifIFD, looking for
// DateTimeOriginal (0x9003), then DateTime (0x0132) as a fallback.
// ----------------------------------------------------------------------------
function readExifDateTimeOriginal(filePath) {
  let buf;
  try { buf = fs.readFileSync(filePath); } catch { return null; }
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null; // not a JPEG

  // Find the APP1 (0xFFE1) segment carrying "Exif\0\0".
  let off = 2;
  let exifStart = -1;
  while (off + 4 <= buf.length) {
    if (buf[off] !== 0xff) break;
    const marker = buf[off + 1];
    if (marker === 0xda || marker === 0xd9) break; // SOS / EOI — no more metadata
    const segLen = buf.readUInt16BE(off + 2);
    if (marker === 0xe1 && buf.toString('ascii', off + 4, off + 10) === 'Exif\0\0') {
      exifStart = off + 10;
      break;
    }
    off += 2 + segLen;
  }
  if (exifStart < 0) return null;

  // TIFF header: byte order + magic 42 + offset to IFD0.
  const tiff = exifStart;
  const bomLE = buf.toString('ascii', tiff, tiff + 2) === 'II';
  const u16 = (o) => (bomLE ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = (o) => (bomLE ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  if (u16(tiff + 2) !== 42) return null;

  const readAscii = (valOff, count) => {
    const s = buf.toString('ascii', valOff, valOff + count);
    return s.replace(/\0.*$/, '').trim();
  };
  // Parse an IFD; collect a tag value (ASCII) and any ExifIFD pointer.
  function scanIFD(ifdOff, want) {
    if (ifdOff <= 0 || ifdOff + 2 > buf.length) return {};
    const n = u16(ifdOff);
    let found = null;
    let exifPtr = 0;
    for (let i = 0; i < n; i++) {
      const e = ifdOff + 2 + i * 12;
      if (e + 12 > buf.length) break;
      const tag = u16(e);
      const type = u16(e + 2);
      const count = u32(e + 4);
      const valOffRaw = e + 8;
      const valPtr = count * (type === 2 ? 1 : 4) <= 4 ? valOffRaw : tiff + u32(valOffRaw);
      if (tag === 0x8769) exifPtr = tiff + u32(valOffRaw); // ExifIFD pointer
      if (tag === want && type === 2) found = readAscii(valPtr, count);
    }
    return { found, exifPtr };
  }

  const ifd0 = scanIFD(tiff + u32(tiff + 4), 0x0132); // DateTime lives in IFD0
  let dt = null;
  if (ifd0.exifPtr) {
    const exif = scanIFD(ifd0.exifPtr, 0x9003); // DateTimeOriginal
    dt = exif.found || null;
  }
  if (!dt) dt = ifd0.found || null;
  if (!dt) return null;

  // EXIF format: "YYYY:MM:DD HH:MM:SS" (camera-local, no tz). Treat as local naive.
  const m = dt.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, Y, Mo, D, H, Mi, S] = m.map(Number);
  const ms = new Date(Y, Mo - 1, D, H, Mi, S).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function photoTimestampMs(filePath, { useExif = true } = {}) {
  if (useExif) {
    const exif = readExifDateTimeOriginal(filePath);
    if (exif != null) return { ms: exif, source: 'exif' };
  }
  let ms = 0;
  try { ms = fs.statSync(filePath).mtimeMs; } catch {}
  return { ms, source: 'mtime' };
}

// ----------------------------------------------------------------------------
// Similarity + clustering primitives.
// ----------------------------------------------------------------------------
function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// Exponential same-burst kernel on the EXIF gap → [0,1]. 1 at Δt=0, 0.5 at half-life.
function timeAdjacency(msA, msB, { timeHalfLifeS = DEFAULTS.timeHalfLifeS } = {}) {
  if (!msA || !msB) return 0;
  const dtS = Math.abs(msA - msB) / 1000;
  return Math.pow(2, -dtS / timeHalfLifeS);
}

/**
 * Agglomerative clustering from a symmetric similarity matrix, cutting at
 * `threshold`. Linkage controls how conservative merges are:
 *   single   → merge if ANY cross-pair ≥ threshold (permissive; can chain)
 *   complete → merge only if EVERY cross-pair ≥ threshold (conservative — default)
 *   average  → merge if the mean cross-pair ≥ threshold
 * Returns an array of clusters (each an array of item indexes). Deterministic.
 */
function agglomerative(sim, threshold, linkage = 'complete') {
  const n = sim.length;
  let clusters = Array.from({ length: n }, (_, i) => [i]);
  const linkScore = (A, B) => {
    let best = linkage === 'single' ? -Infinity : Infinity;
    let sum = 0, cnt = 0;
    for (const a of A) for (const b of B) {
      const s = sim[a][b];
      if (linkage === 'single') best = Math.max(best, s);
      else if (linkage === 'complete') best = Math.min(best, s);
      sum += s; cnt++;
    }
    return linkage === 'average' ? sum / cnt : best;
  };
  while (clusters.length > 1) {
    let bi = -1, bj = -1, bestScore = -Infinity;
    for (let i = 0; i < clusters.length; i++)
      for (let j = i + 1; j < clusters.length; j++) {
        const s = linkScore(clusters[i], clusters[j]);
        if (s > bestScore) { bestScore = s; bi = i; bj = j; }
      }
    if (bestScore < threshold) break; // no admissible merge left
    clusters[bi] = clusters[bi].concat(clusters[bj]);
    clusters.splice(bj, 1);
  }
  return clusters;
}

// Build the stable group objects from clusters + a similarity accessor, applying
// the conservative confidence/flag/auto-accept policy shared by all strategies.
function assembleGroups(clusterIdxs, features, sim, opts = {}) {
  const lowConfidence = opts.lowConfidence ?? DEFAULTS.lowConfidence;
  const autoAcceptMin = opts.autoAcceptMin ?? DEFAULTS.autoAcceptMin;
  const signatureOf = opts.signatureOf || ((f) => f.signature || f.file_path || '');
  const multiItemOf = opts.multiItemOf || (() => false);

  const groups = [];
  for (const idxs of clusterIdxs) {
    const members = idxs.map((i) => features[i]);
    const flags = [];
    // A photo showing multiple garments can't define a single item → flag it.
    const multi = idxs.some((i) => multiItemOf(features[i]));
    if (multi) flags.push('multi_item_photo');

    let confidence;
    if (idxs.length === 1) {
      // A lone photo is more often a fragment split off from its item than a genuine
      // one-shot item (resale items are shot front+back+tag). Keep singletons BELOW the
      // auto-accept bar so they're flagged for review — confirm it or merge it — rather
      // than silently accepted (PRD §8.9: flag more, not less). The explicit flag lets
      // the review UI say WHY ("single photo") instead of a generic low-confidence line.
      confidence = multi ? 0 : 0.65;
      if (!multi) flags.push('singleton_review');
    } else {
      let s = 0, c = 0;
      for (let a = 0; a < idxs.length; a++)
        for (let b = a + 1; b < idxs.length; b++) { s += sim[idxs[a]][idxs[b]]; c++; }
      confidence = c ? Number((s / c).toFixed(3)) : 1;
    }
    if (!multi && idxs.length > 1 && confidence < lowConfidence) flags.push('low_confidence_group');

    groups.push({
      _idxs: idxs,
      photos: members.map((m) => m.file_path),
      signature: signatureOf(members[0]),
      confidence,
      autoAccept: flags.length === 0 && confidence >= autoAcceptMin,
      flags,
    });
  }
  // Stable ordering: by earliest member index, then assign 1-based ids.
  groups.sort((a, b) => Math.min(...a._idxs) - Math.min(...b._idxs));
  return groups.map((g, i) => ({
    groupId: i + 1,
    photos: g.photos,
    signature: g.signature,
    confidence: g.confidence,
    autoAccept: g.autoAccept,
    flags: g.flags,
  }));
}

// ----------------------------------------------------------------------------
// Base class
// ----------------------------------------------------------------------------
class GroupingStrategy {
  // eslint-disable-next-line no-unused-vars
  async group(photoPaths, opts = {}) {
    throw new Error('group() not implemented');
  }
}

// ----------------------------------------------------------------------------
// 1) Descriptor + Jaccard (baseline, and an improved EXIF/complete-linkage mode)
// ----------------------------------------------------------------------------
class DescriptorJaccardStrategy extends GroupingStrategy {
  constructor(config = {}) {
    super();
    this.model = config.model || process.env.CLUSTER_MODEL || 'claude-opus-4-8';
    this.mode = config.mode || 'improved'; // 'baseline' | 'improved'
    this.useExif = config.useExif ?? (this.mode === 'improved');
    // 'average' linkage lets an out-of-order tag close-up attach to its burst without
    // the chaining single-linkage would allow across items (cross-item pairs are already
    // pushed toward 0 by the time term, so this stays conservative).
    this.linkage = config.linkage || (this.mode === 'improved' ? 'average' : 'single');
    // Improved mode uses a slightly higher bar so a bare garment-type match (0.5) can't
    // merge two different items on its own; baseline keeps the original 0.5.
    this.joinThreshold = config.joinThreshold ?? (this.mode === 'improved' ? 0.52 : DEFAULTS.joinThreshold);
    this.lowConfidence = config.lowConfidence ?? DEFAULTS.lowConfidence;
    this.autoAcceptMin = config.autoAcceptMin ?? DEFAULTS.autoAcceptMin;
    this.visualWeight = config.visualWeight ?? DEFAULTS.visualWeight;
    this.timeHalfLifeS = config.timeHalfLifeS ?? DEFAULTS.timeHalfLifeS;
    this.concurrency = config.concurrency || 4;
    // For offline/fixture runs the harness supplies descriptors directly.
    this._describe = config.describe || describePhoto;
  }

  // Pure VISUAL similarity: garment type + colors + brand/graphic text. Same weights as
  // the baseline's descriptorSimilarity but WITHOUT its built-in timestamp boost, so the
  // time signal is fused explicitly and controllably below.
  _visualSim(a, b) {
    const t = (s) => new Set(String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter((w) => w.length > 1));
    const jac = (A, B) => { if (!A.size && !B.size) return 0; let i = 0; for (const x of A) if (B.has(x)) i++; return i / (A.size + B.size - i); };
    const garment = a.garment_type && b.garment_type && a.garment_type.toLowerCase() === b.garment_type.toLowerCase() ? 1 : 0;
    const colorSim = jac(t((a.colors || []).join(' ')), t((b.colors || []).join(' ')));
    const textSim = jac(t(`${a.visible_text} ${a.signature}`), t(`${b.visible_text} ${b.signature}`));
    return 0.5 * garment + 0.2 * colorSim + 0.3 * textSim;
  }

  // similarity between two descriptors.
  //   baseline  → the original lexical similarity (with its mtime-based boost), unchanged.
  //   improved  → convex fusion  score = w·visual + (1-w)·timeAdjacency(EXIF)
  //               This both SEPARATES visually-similar different-item shots taken far apart
  //               (e.g. a grey hoodie on day 1 vs a black hoodie on day 2) and ATTACHES an
  //               out-of-order tag close-up to the rest of its seconds-apart burst.
  _sim(a, b) {
    if (this.mode !== 'improved') return Math.min(1, descriptorSimilarity(a, b));
    const visual = this._visualSim(a, b);
    // Fuse the time-prior ONLY when both photos have a trustworthy EXIF capture time.
    // Falling back to filesystem mtime is worse than useless (copy/export makes every
    // mtime nearly identical → a bogus "everything is adjacent" signal), so when EXIF is
    // absent we cluster on vision alone rather than trust mtime.
    if (!a._timeTrusted || !b._timeTrusted) return Math.min(1, visual);
    const tAdj = timeAdjacency(a.timestamp, b.timestamp, { timeHalfLifeS: this.timeHalfLifeS });
    return Math.min(1, this.visualWeight * visual + (1 - this.visualWeight) * tAdj);
  }

  async group(photoPaths, opts = {}) {
    const t0 = Date.now();
    const client = opts.client;
    let usage = { input_tokens: 0, output_tokens: 0 };
    let calls = 0;

    // Descriptors: from the harness cache/fixtures if provided, else one vision call each.
    let descriptors = opts.descriptors;
    if (!descriptors) {
      let described = 0;
      descriptors = await mapLimit(photoPaths, this.concurrency, async (f) => {
        const d = await this._describe(f, { client, model: this.model });
        calls++;
        notifyProgress(opts, { phase: 'describe', done: ++described, total: photoPaths.length });
        if (d.__usage) { usage.input_tokens += d.__usage.input_tokens || 0; usage.output_tokens += d.__usage.output_tokens || 0; }
        return d;
      });
    }
    // Ensure file_path + timestamp are set (EXIF in improved mode).
    descriptors = descriptors.map((d, i) => {
      const file_path = d.file_path || photoPaths[i];
      let timestamp = d.timestamp;
      let timeTrusted = false;
      if (this.mode === 'improved') {
        const ts = photoTimestampMs(file_path, { useExif: this.useExif });
        timestamp = ts.ms;
        timeTrusted = ts.source === 'exif';
      } else if (timestamp == null) {
        timestamp = photoTimestampMs(file_path, { useExif: false }).ms;
      }
      return { ...d, file_path, timestamp, _timeTrusted: timeTrusted };
    });

    // Similarity matrix.
    const n = descriptors.length;
    const sim = Array.from({ length: n }, () => new Array(n).fill(0));
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      const s = descriptors[i].contains_multiple_items || descriptors[j].contains_multiple_items ? 0 : this._sim(descriptors[i], descriptors[j]);
      sim[i][j] = sim[j][i] = s;
    }

    // Cluster. Multi-item photos are pulled out into their own singleton groups first.
    const multiIdx = new Set(descriptors.map((d, i) => (d.contains_multiple_items ? i : -1)).filter((i) => i >= 0));
    const normalIdx = descriptors.map((_, i) => i).filter((i) => !multiIdx.has(i));
    const subSim = normalIdx.map((a) => normalIdx.map((b) => sim[a][b]));
    const subClusters = agglomerative(subSim, this.joinThreshold, this.linkage).map((c) => c.map((k) => normalIdx[k]));
    const clusterIdxs = subClusters.concat([...multiIdx].map((i) => [i]));

    const groups = assembleGroups(clusterIdxs, descriptors, sim, {
      lowConfidence: this.lowConfidence,
      autoAcceptMin: this.autoAcceptMin,
      multiItemOf: (f) => !!f.contains_multiple_items,
      signatureOf: (f) => f.signature || '',
    });

    return {
      groups,
      features: descriptors,
      meta: {
        strategy: `descriptor-jaccard:${this.mode}`,
        model: this.model, calls,
        usage, estCostUsd: usdFromUsage(usage, this.model),
        wallMs: Date.now() - t0,
        notes: `linkage=${this.linkage} exif=${this.useExif} join=${this.joinThreshold}`,
      },
    };
  }
}

// ----------------------------------------------------------------------------
// 2) Single batched vision call — model assigns group ids directly.
// ----------------------------------------------------------------------------
const BATCH_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    assignments: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          index: { type: 'number', description: 'The photo index as labeled in the prompt.' },
          group_id: { type: 'number', description: 'Integer id; photos of the SAME physical item share one id.' },
          signature: { type: 'string', description: 'Short phrase identifying the item this photo belongs to.' },
          confidence: { type: 'number', description: '0.0–1.0 confidence this photo belongs to that group.' },
          contains_multiple_items: { type: 'boolean', description: 'True if this photo clearly shows more than one distinct garment.' },
        },
        required: ['index', 'group_id', 'signature', 'confidence', 'contains_multiple_items'],
      },
    },
  },
  required: ['assignments'],
};

const BATCH_SYSTEM =
  'You sort photos from ONE resale photo shoot into per-item groups. The shoot contains several ' +
  'garments, each shot from multiple angles plus tag/label close-ups. Assign every photo a group_id ' +
  'so that all photos of the SAME physical garment share one id (a full-garment shot and its own tag ' +
  'close-up belong together; two different garments of the same brand do NOT). Be conservative: if two ' +
  'photos might be different items, give them different ids and lower their confidence. ' +
  'Each photo is labeled with its capture time relative to the first photo. Photos of one garment are ' +
  'usually captured within seconds to a couple of minutes of each other, so treat a small time gap as a ' +
  'STRONG hint two photos are the same item and a large gap as a hint they may differ — but the images ' +
  'are the final say: identical times with clearly different garments are different items, and a late ' +
  'extra angle can still belong to an earlier item. Describe only what you see; do not identify brands ' +
  'you cannot read.';

class BatchedVisionStrategy extends GroupingStrategy {
  constructor(config = {}) {
    super();
    this.model = config.model || process.env.CLUSTER_MODEL || 'claude-opus-4-8';
    this.autoAcceptMin = config.autoAcceptMin ?? DEFAULTS.autoAcceptMin;
    this.lowConfidence = config.lowConfidence ?? DEFAULTS.lowConfidence;
    this.useExifTiebreak = config.useExifTiebreak ?? true;
    // Starting downscale resolution (matches the benchmark). prepareBatchImages keeps
    // this for batches that fit and steps DOWN a ladder only when a shoot is too big/heavy,
    // so normal batches keep full quality and large ones still fit. Override via env.
    this.maxEdge = config.maxEdge || Number(process.env.CLUSTER_MAX_EDGE) || 1024;
    this.quality = config.quality || Number(process.env.CLUSTER_JPEG_QUALITY) || 80;
    this.budgetBytes = config.budgetBytes || 26e6; // stay comfortably under Anthropic's ~32 MB request cap
    // Large-shoot guard (integration plan P0.3): the batched call sends every photo in ONE
    // request, and Anthropic caps ~100 images / ~32 MB payload. Above this COUNT we refuse
    // (throw SHOOT_TOO_LARGE) so groupBatch's fallback runs descriptor-improved instead
    // (per-photo calls have no single-request cap). Goal cap = 75; override via env.
    this.maxPhotos = config.maxPhotos ?? (Number(process.env.CLUSTER_MAX_PHOTOS) || 75);
  }

  async group(photoPaths, opts = {}) {
    const t0 = Date.now();
    const client = opts.client || new Anthropic();

    // If the harness pre-computed a batched result (cache/fixture), reuse it.
    let assignments = opts.assignments;
    let usage = { input_tokens: 0, output_tokens: 0 };
    let calls = 0;
    if (!assignments) {
      if (photoPaths.length > this.maxPhotos) {
        const err = new Error(
          `shoot too large for one batched request (${photoPaths.length} photos > ${this.maxPhotos} cap)`
        );
        err.code = 'SHOOT_TOO_LARGE';
        throw err;
      }
      // EXIF capture-time labels (relative to the first shot) — a strong same-item prior
      // that stays reliable even when images are downscaled for payload.
      const exifMs = photoPaths.map((p) => readExifDateTimeOriginal(p));
      const baseMs = exifMs.filter((x) => x != null).sort((a, b) => a - b)[0] ?? null;
      const timeLabel = (i) => (baseMs != null && exifMs[i] != null ? fmtElapsed(exifMs[i] - baseMs) : 'time unknown');

      // Adaptive downscale so the whole shoot fits under the request cap (throws
      // SHOOT_TOO_LARGE → groupBatch fallback if even reduced resolution won't fit).
      const { temps } = await prepareBatchImages(photoPaths, {
        maxEdge: this.maxEdge, quality: this.quality, budgetBytes: this.budgetBytes,
        onEach: (done, total) => notifyProgress(opts, { phase: 'prepare', done, total }),
      });
      const content = [];
      try {
        for (let i = 0; i < temps.length; i++) {
          content.push({ type: 'text', text: `Photo ${i} (captured ${timeLabel(i)}):` });
          content.push(imageBlock(temps[i]));
        }
        content.push({ type: 'text', text:
          `Assign a group_id to each of the ${photoPaths.length} photos (indexes 0..${photoPaths.length - 1}). ` +
          `Photos of the same physical garment share one id. Use the capture-time labels as a strong prior ` +
          `(close in time → likely the same item) but let the images decide.` });
        // The batched call is one opaque request — no denominator until it returns.
        notifyProgress(opts, { phase: 'analyze', done: 0, total: 0 });
        const resp = await client.messages.create({
          model: this.model,
          // Scale with shoot size: ~55 output tokens per assignment (+ adaptive-
          // thinking headroom). A fixed 3000 truncated mid-JSON ("Unterminated
          // string") on a 56-photo shoot — found by the 2026-07-21 cost sweep.
          max_tokens: Math.max(3000, photoPaths.length * 80 + 2000),
          output_config: outputConfig(this.model, BATCH_SCHEMA, 'medium'),
          system: BATCH_SYSTEM,
          messages: [{ role: 'user', content }],
        });
        calls = 1;
        usage = resp.usage || usage;
        const tb = resp.content.find((b) => b.type === 'text');
        assignments = JSON.parse(tb.text).assignments;
      } finally {
        for (const t of temps) { try { fs.unlinkSync(t); } catch {} }
      }
    }

    // Build features aligned to photoPaths.
    const byIndex = new Map(assignments.map((a) => [a.index, a]));
    const features = photoPaths.map((p, i) => {
      const a = byIndex.get(i) || { group_id: 1000 + i, signature: path.basename(p), confidence: 0.5, contains_multiple_items: false };
      return { file_path: p, group_id: a.group_id, signature: a.signature, confidence: a.confidence, contains_multiple_items: a.contains_multiple_items, timestamp: photoTimestampMs(p).ms };
    });

    // Group by model-assigned id; multi-item photos become their own singleton groups.
    const byGroup = new Map();
    features.forEach((f, i) => {
      if (f.contains_multiple_items) { byGroup.set(`multi:${i}`, [i]); return; }
      const k = `g:${f.group_id}`;
      if (!byGroup.has(k)) byGroup.set(k, []);
      byGroup.get(k).push(i);
    });
    const clusterIdxs = [...byGroup.values()];

    // Similarity matrix = per-pair min model confidence, nudged by EXIF agreement,
    // so assembleGroups can compute a meaningful group confidence.
    const n = features.length;
    const sim = Array.from({ length: n }, () => new Array(n).fill(0));
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      const same = features[i].group_id === features[j].group_id && !features[i].contains_multiple_items && !features[j].contains_multiple_items;
      let s = same ? Math.min(features[i].confidence, features[j].confidence) : 0;
      if (same && this.useExifTiebreak) s = Math.min(1, s * (0.85 + 0.15 * timeAdjacency(features[i].timestamp, features[j].timestamp)));
      sim[i][j] = sim[j][i] = s;
    }

    const groups = assembleGroups(clusterIdxs, features, sim, {
      lowConfidence: this.lowConfidence,
      autoAcceptMin: this.autoAcceptMin,
      multiItemOf: (f) => !!f.contains_multiple_items,
      signatureOf: (f) => f.signature || '',
    });

    return {
      groups, features,
      meta: {
        strategy: 'batched-vision', model: this.model, calls,
        usage, estCostUsd: usdFromUsage(usage, this.model),
        wallMs: Date.now() - t0, notes: 'single multimodal call, model-assigned group ids',
      },
    };
  }
}

// ----------------------------------------------------------------------------
// 3) Embedding strategy + pluggable backends.
// ----------------------------------------------------------------------------
class EmbeddingBackend {
  // eslint-disable-next-line no-unused-vars
  async embed(photoPaths) { throw new Error('embed() not implemented'); } // -> { vectors: number[][], usage?, calls? }
}

// Voyage AI multimodal embeddings (hosted). Needs VOYAGE_API_KEY in .env.local.
class VoyageBackend extends EmbeddingBackend {
  constructor(config = {}) {
    super();
    this.apiKey = config.apiKey || process.env.VOYAGE_API_KEY || null;
    this.model = config.model || process.env.VOYAGE_MODEL || 'voyage-multimodal-3';
    this.endpoint = config.endpoint || 'https://api.voyageai.com/v1/multimodalembeddings';
    this.timeoutMs = config.timeoutMs || 30000;
  }
  async embed(photoPaths) {
    if (!this.apiKey) throw new Error('VOYAGE_API_KEY is not set (.env.local). See docs/clustering-methods-research.md.');
    const inputs = photoPaths.map((p) => {
      const ext = path.extname(p).toLowerCase();
      const mt = MEDIA_TYPES[ext] || 'image/jpeg';
      const b64 = fs.readFileSync(p).toString('base64');
      return { content: [{ type: 'image_base64', image_base64: `data:${mt};base64,${b64}` }] };
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let json;
    try {
      const res = await fetch(this.endpoint, {
        method: 'POST', signal: controller.signal,
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model, input_type: 'document', inputs }),
      });
      if (!res.ok) throw new Error(`Voyage HTTP ${res.status} ${res.statusText}: ${(await res.text()).slice(0, 200)}`);
      json = await res.json();
    } finally { clearTimeout(timer); }
    const vectors = (json.data || []).map((d) => d.embedding);
    return { vectors, usage: json.usage, calls: 1 };
  }
}

// Local CLIP via transformers.js (ONNX). Runs on the Mac; no key, no egress.
// Requires: npm i @huggingface/transformers  (not installable in the CI sandbox).
class LocalClipBackend extends EmbeddingBackend {
  constructor(config = {}) {
    super();
    this.model = config.model || process.env.CLIP_MODEL || 'Xenova/clip-vit-base-patch32';
  }
  async embed(photoPaths) {
    let transformers;
    try { transformers = require('@huggingface/transformers'); }
    catch { throw new Error('@huggingface/transformers not installed. Run `npm i @huggingface/transformers` on the Mac to use LocalClipBackend.'); }
    const { pipeline, RawImage } = transformers;
    const extractor = await pipeline('image-feature-extraction', this.model);
    const vectors = [];
    for (const p of photoPaths) {
      const img = await RawImage.read(p);
      const out = await extractor(img, { pooling: 'mean', normalize: true });
      vectors.push(Array.from(out.data));
    }
    return { vectors, usage: null, calls: 0 };
  }
}

class EmbeddingStrategy extends GroupingStrategy {
  constructor(config = {}) {
    super();
    this.backend = config.backend || new VoyageBackend(config);
    this.cosineJoin = config.cosineJoin ?? DEFAULTS.cosineJoin;
    this.linkage = config.linkage || DEFAULTS.linkage;
    this.timeAlpha = config.timeAlpha ?? DEFAULTS.timeAlpha;
    this.autoAcceptMin = config.autoAcceptMin ?? DEFAULTS.autoAcceptMin;
    this.lowConfidence = config.lowConfidence ?? DEFAULTS.lowConfidence;
    this.name = config.name || (this.backend.constructor === LocalClipBackend ? 'embedding-clip' : 'embedding-voyage');
  }

  async group(photoPaths, opts = {}) {
    const t0 = Date.now();
    let vectors = opts.vectors;
    let usage = null, calls = 0;
    if (!vectors) {
      const r = await this.backend.embed(photoPaths);
      vectors = r.vectors; usage = r.usage; calls = r.calls || 0;
    }
    const features = photoPaths.map((p, i) => ({ file_path: p, embedding: vectors[i], timestamp: photoTimestampMs(p).ms }));

    // Fused score = (1-alpha)*cosine + alpha*time_adjacency, both in [0,1].
    const n = features.length;
    const sim = Array.from({ length: n }, () => new Array(n).fill(0));
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      const cos01 = (cosine(features[i].embedding, features[j].embedding) + 1) / 2; // map [-1,1]→[0,1]
      const t = timeAdjacency(features[i].timestamp, features[j].timestamp);
      const s = (1 - this.timeAlpha) * cos01 + this.timeAlpha * t;
      sim[i][j] = sim[j][i] = s;
    }
    // Threshold expressed on the fused scale: blend the cosine join with the time weight.
    const joinFused = (1 - this.timeAlpha) * ((this.cosineJoin + 1) / 2) + this.timeAlpha * 0.0;
    const clusterIdxs = agglomerative(sim, joinFused, this.linkage);

    const groups = assembleGroups(clusterIdxs, features, sim, {
      lowConfidence: this.lowConfidence,
      autoAcceptMin: this.autoAcceptMin,
      signatureOf: (f) => path.basename(f.file_path),
    });

    return {
      groups, features: features.map((f) => ({ file_path: f.file_path, timestamp: f.timestamp, dims: f.embedding ? f.embedding.length : 0 })),
      meta: {
        strategy: this.name, model: this.backend.model, calls, usage,
        estCostUsd: null, wallMs: Date.now() - t0,
        notes: `cosineJoin=${this.cosineJoin} timeAlpha=${this.timeAlpha} linkage=${this.linkage}`,
      },
    };
  }
}

// ----------------------------------------------------------------------------
// Factory
// ----------------------------------------------------------------------------
function makeGroupingStrategy(name, opts = {}) {
  const key = (name || process.env.GROUPING_STRATEGY || 'descriptor-improved').toLowerCase();
  switch (key) {
    case 'baseline':
    case 'descriptor-baseline':
      return new DescriptorJaccardStrategy({ ...opts, mode: 'baseline' });
    case 'descriptor':
    case 'descriptor-improved':
    case 'improved':
      return new DescriptorJaccardStrategy({ ...opts, mode: 'improved' });
    case 'descriptor-haiku':
      return new DescriptorJaccardStrategy({ ...opts, mode: 'improved', model: 'claude-haiku-4-5-20251001' });
    case 'batched':
    case 'batched-vision':
      return new BatchedVisionStrategy(opts);
    case 'batched-haiku':
      return new BatchedVisionStrategy({ ...opts, model: 'claude-haiku-4-5-20251001' });
    case 'embedding-voyage':
      return new EmbeddingStrategy({ ...opts, backend: new VoyageBackend(opts) });
    case 'embedding-clip':
    case 'embedding-local':
      return new EmbeddingStrategy({ ...opts, backend: new LocalClipBackend(opts), name: 'embedding-clip' });
    default:
      throw new Error(`Unknown grouping strategy "${name}"`);
  }
}

module.exports = {
  GroupingStrategy,
  DescriptorJaccardStrategy,
  BatchedVisionStrategy,
  EmbeddingStrategy,
  EmbeddingBackend, VoyageBackend, LocalClipBackend,
  makeGroupingStrategy,
  // primitives (used by the harness + tests)
  readExifDateTimeOriginal, photoTimestampMs, cosine, timeAdjacency, agglomerative, assembleGroups,
  downscaleToTemp, prepareBatchImages, fmtElapsed, usdFromUsage, priceFor, DEFAULTS, PRICES,
};
