// Avatar profiles: one TOML file per avatar mapping received expressions to blendshapes.
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { parse } = require('smol-toml');

function dir() {
  return path.join(app.getPath('userData'), 'avatar_profiles');
}

function ensure(bundledDir) {
  const d = dir();
  fs.mkdirSync(d, { recursive: true });
  const sample = path.join(d, 'sample.toml');
  const src = path.join(bundledDir, 'sample.toml');
  if (!fs.existsSync(sample) && fs.existsSync(src)) fs.copyFileSync(src, sample);
}

function clampWeight(v, def) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(100, Math.max(0, n));
}

async function list() {
  const d = dir();
  let files = [];
  try { files = await fs.promises.readdir(d); } catch { return { dir: d, profiles: [], errors: [] }; }
  const profiles = [];
  const errors = [];
  for (const f of files.sort()) {
    if (!f.toLowerCase().endsWith('.toml') || f.toLowerCase() === 'sample.toml') continue;
    const full = path.join(d, f);
    try {
      const doc = parse(await fs.promises.readFile(full, 'utf8'));
      const expressions = [];
      for (const e of Array.isArray(doc.expressions) ? doc.expressions : []) {
        if (!e || typeof e.source !== 'string' || typeof e.target !== 'string') {
          errors.push({ file: f, message: 'expressions entry needs "source" and "target"' });
          continue;
        }
        expressions.push({
          source: e.source,
          target: e.target,
          renderer: typeof e.renderer === 'string' && e.renderer ? e.renderer : null,
          minWeight: clampWeight(e.min_weight, 0),
          maxWeight: clampWeight(e.max_weight, 100),
        });
      }
      profiles.push({ file: f, name: typeof doc.name === 'string' && doc.name ? doc.name : f.replace(/\.toml$/i, ''), expressions });
    } catch (err) {
      errors.push({ file: f, message: String(err.message || err) });
    }
  }
  return { dir: d, profiles, errors };
}

module.exports = { dir, ensure, list };
