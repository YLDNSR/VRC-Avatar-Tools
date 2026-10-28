// Tiny JSON settings store persisted in the user data folder.
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

let data = null;
let timer = null;

function file() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function load() {
  if (data) return data;
  try {
    data = JSON.parse(fs.readFileSync(file(), 'utf8'));
  } catch {
    data = {};
  }
  return data;
}

function flush() {
  if (!data) return;
  clearTimeout(timer);
  timer = null;
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file() + '.tmp', JSON.stringify(data, null, 2));
    fs.renameSync(file() + '.tmp', file());
  } catch (err) {
    console.error('settings save failed', err);
  }
}

module.exports = {
  all() {
    return load();
  },
  get(key) {
    return load()[key];
  },
  set(key, value) {
    load()[key] = value;
    clearTimeout(timer);
    timer = setTimeout(flush, 400);
  },
  flush,
};
