// Reads title/author/thumbnail from a VRM/GLB without loading the whole file.
const fs = require('node:fs');
const path = require('node:path');

async function readRange(fh, offset, length) {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await fh.read(buf, 0, length, offset);
  return buf.subarray(0, bytesRead);
}

async function readAvatarMeta(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.gltf') {
    const json = JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
    return metaFromJson(json, null, null);
  }
  const fh = await fs.promises.open(filePath, 'r');
  try {
    const header = await readRange(fh, 0, 20);
    if (header.length < 20 || header.toString('ascii', 0, 4) !== 'glTF') return {};
    const jsonLen = header.readUInt32LE(12);
    const jsonType = header.readUInt32LE(16);
    if (jsonType !== 0x4e4f534a || jsonLen > 64 * 1024 * 1024) return {};
    const json = JSON.parse((await readRange(fh, 20, jsonLen)).toString('utf8'));
    const binHeaderOffset = 20 + jsonLen;
    const binHeader = await readRange(fh, binHeaderOffset, 8);
    const binStart = binHeader.length === 8 ? binHeaderOffset + 8 : null;
    return metaFromJson(json, fh, binStart);
  } finally {
    await fh.close();
  }
}

async function metaFromJson(json, fh, binStart) {
  const out = { version: '', title: '', author: '', thumbnail: null };
  let imageIndex = null;
  const ext = json.extensions || {};
  if (ext.VRMC_vrm) {
    const meta = ext.VRMC_vrm.meta || {};
    out.version = 'VRM 1.0';
    out.title = meta.name || '';
    out.author = (meta.authors || []).join(', ');
    if (typeof meta.thumbnailImage === 'number') imageIndex = meta.thumbnailImage;
  } else if (ext.VRM) {
    const meta = ext.VRM.meta || {};
    out.version = 'VRM 0.x';
    out.title = meta.title || '';
    out.author = meta.author || '';
    if (typeof meta.texture === 'number' && json.textures && json.textures[meta.texture]) {
      imageIndex = json.textures[meta.texture].source;
    }
  } else {
    out.version = 'glTF';
  }
  if (imageIndex != null && json.images && json.images[imageIndex] && fh && binStart != null) {
    const img = json.images[imageIndex];
    const bv = json.bufferViews && json.bufferViews[img.bufferView];
    if (bv && (bv.buffer || 0) === 0 && bv.byteLength < 16 * 1024 * 1024) {
      const bytes = await readRange(fh, binStart + (bv.byteOffset || 0), bv.byteLength);
      out.thumbnail = `data:${img.mimeType || 'image/png'};base64,${bytes.toString('base64')}`;
    }
  }
  return out;
}

module.exports = { readAvatarMeta };
