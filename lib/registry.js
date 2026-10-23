'use strict';

/*
 * Loads every adapter module in ../adapters, filters to the ones enabled in
 * config whose CLI binary is actually present, and builds a model registry so
 * requests can resolve a model string -> { adapter, cliModel }.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ADAPTERS_DIR = path.join(__dirname, '..', 'adapters');

function binExists(bin) {
  try { execFileSync('sh', ['-c', `command -v ${JSON.stringify(bin).slice(1, -1)}`], { stdio: 'ignore' }); return true; }
  catch { return false; }
}

function load(config) {
  const adapters = {};      // id -> adapter module
  const cfgs = {};          // id -> resolved per-adapter config
  const files = fs.readdirSync(ADAPTERS_DIR).filter((f) => f.endsWith('.js'));

  for (const f of files) {
    let mod;
    try { mod = require(path.join(ADAPTERS_DIR, f)); }
    catch (e) { console.warn(`  ! adapter ${f} failed to load: ${e.message}`); continue; }
    if (!mod || !mod.id) continue;

    const cfg = (config.adapters && config.adapters[mod.id]) || {};
    if (cfg.enabled === false) continue;
    const bin = cfg.bin || mod.bin || mod.id;
    const present = binExists(bin);
    if (!present && !cfg.force) {
      console.warn(`  - ${mod.id}: CLI '${bin}' not found on PATH — skipping (set adapters.${mod.id}.force to include anyway)`);
      continue;
    }
    adapters[mod.id] = mod;
    cfgs[mod.id] = { ...cfg, bin };
    console.log(`  + ${mod.id}: ready (${bin})`);
  }

  // build model index
  const index = {};         // lookup key -> { id(model), adapter, cliModel, owned_by }
  const list = [];          // for /v1/models
  for (const id of Object.keys(adapters)) {
    const a = adapters[id];
    const models = (typeof a.listModels === 'function' ? a.listModels(cfgs[id]) : a.models) || [];
    for (const m of models) {
      const full = `${id}/${m.id}`;
      const entry = { id: full, adapter: a, cfg: cfgs[id], cliModel: m.cli || m.id, owned_by: id };
      list.push({ id: full, object: 'model', created: 0, owned_by: id });
      // resolvable by: namespaced id, bare model id, and any aliases
      index[full.toLowerCase()] = entry;
      index[m.id.toLowerCase()] = index[m.id.toLowerCase()] || entry;
      for (const alias of m.alias || []) {
        index[alias.toLowerCase()] = index[alias.toLowerCase()] || entry;
        index[`${id}/${alias}`.toLowerCase()] = entry;
      }
    }
  }

  return { adapters, cfgs, index, list };
}

module.exports = { load, binExists };
