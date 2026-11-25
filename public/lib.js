/* Pure helpers: no DOM, no network. Works in the browser (window.BrollLib) and in Node (require). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BrollLib = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const encoder = new TextEncoder();

  function slug(s, max) {
    const out = String(s || '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, max || 40)
      .replace(/-+$/g, '');
    return out || 'untitled';
  }

  function wordCount(s) {
    return (String(s || '').match(/\S+/g) || []).length;
  }

  // One image roughly every `secondsPerImage` seconds of narration.
  function estimateImages(words, secondsPerImage, wpm) {
    const spi = secondsPerImage || 5.5;
    const rate = wpm || 150;
    return Math.max(0, Math.ceil(((words / rate) * 60) / spi));
  }

  const norm = (w) => w.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

  // Cut the script into one chunk per scene using each scene's `start` words.
  // Falls back to an equal split by word count when the starts cannot be located.
  function splitScenes(script, scenes) {
    const text = String(script || '');
    const words = [];
    const re = /\S+/g;
    let m;
    while ((m = re.exec(text))) words.push({ n: norm(m[0]), at: m.index });
    const total = words.length;
    const count = scenes.length;
    if (!total || !count) return { parts: scenes.map(() => ''), aligned: false };

    const sliceBy = (bounds) =>
      bounds.map((b, i) => {
        const from = words[b].at;
        const to = i + 1 < bounds.length ? words[bounds[i + 1]].at : text.length;
        return text.slice(from, to).trim();
      });

    const bounds = [];
    let pointer = 0;
    let ok = true;
    for (let i = 0; i < count && ok; i++) {
      const keys = String(scenes[i].start || '')
        .split(/\s+/)
        .map(norm)
        .filter(Boolean)
        .slice(0, 6);
      if (keys.length < 3) {
        ok = false;
        break;
      }
      let found = -1;
      for (let j = pointer; j + keys.length <= total; j++) {
        let hit = true;
        for (let k = 0; k < keys.length; k++) {
          if (words[j + k].n !== keys[k]) {
            hit = false;
            break;
          }
        }
        if (hit) {
          found = j;
          break;
        }
      }
      if (found === -1) {
        ok = false;
        break;
      }
      bounds.push(found);
      pointer = found + 1;
    }

    if (ok) {
      bounds[0] = 0; // anything before the first scene belongs to it
      return { parts: sliceBy(bounds), aligned: true };
    }
    const eq = scenes.map((_, i) => Math.floor((i * total) / count));
    return { parts: sliceBy(eq), aligned: false };
  }

  function extFromType(contentType, url) {
    const t = String(contentType || '').toLowerCase();
    if (t.includes('jpeg') || t.includes('jpg')) return 'jpg';
    if (t.includes('png')) return 'png';
    if (t.includes('webp')) return 'webp';
    if (t.includes('gif')) return 'gif';
    const m = String(url || '').split(/[?#]/)[0].match(/\.([a-z0-9]{3,4})$/i);
    return m ? m[1].toLowerCase() : 'jpg';
  }

  function buildCredits(info) {
    const lines = [];
    lines.push(`B-ROLL PACK: ${info.title}`);
    lines.push(`Generated: ${info.generated}`);
    lines.push('');
    lines.push('Attribution and licence details for every file in this pack.');
    lines.push('Items marked NEEDS VERIFY must be checked on their source page before you use them.');
    lines.push('These labels are a convenience, not legal advice.');
    lines.push('='.repeat(72));
    lines.push('');
    for (const a of info.assets) {
      lines.push(`[${a.path}]`);
      lines.push(`  Title:   ${a.title}`);
      lines.push(`  Author:  ${a.author}`);
      lines.push(`  Source:  ${a.source}: ${a.page}`);
      lines.push(`  Licence: ${a.license}${a.licenseUrl ? ` (${a.licenseUrl})` : ''}`);
      if (a.status === 'verify') lines.push('  Check:   NEEDS VERIFY');
      if (a.note) lines.push(`  Note:    ${a.note}`);
      lines.push('');
    }
    return lines.join('\n');
  }

  function buildNotDownloaded(items) {
    const lines = [
      'Items that are not inside the ZIP (videos are too large to bundle, or a download failed).',
      'Open the link to get them.',
      '',
    ];
    for (const it of items) {
      lines.push(`[${it.sceneLabel}] ${it.title}`);
      lines.push(`  Reason:  ${it.reason}`);
      lines.push(`  Page:    ${it.page}`);
      if (it.download) lines.push(`  File:    ${it.download}`);
      lines.push(`  Licence: ${it.license}`);
      lines.push('');
    }
    return lines.join('\n');
  }

  // ---------------------------------------------------------------- ZIP (store only)
  const CRC_TABLE = (function () {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  // files: [{ name: 'folder/file.txt', data: Uint8Array | string }]
  // Images are already compressed, so entries are stored without deflate.
  function buildZip(files, when) {
    const d = when || new Date();
    const dosTime = ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff;
    const dosDate = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;

    const entries = files.map((f) => {
      const data = typeof f.data === 'string' ? encoder.encode(f.data) : f.data;
      return { name: encoder.encode(f.name), data, crc: crc32(data), offset: 0 };
    });
    if (entries.length > 65534) throw new Error('Too many files for a ZIP');

    let size = 22; // end-of-central-directory record
    for (const e of entries) size += 30 + e.name.length + e.data.length + 46 + e.name.length;
    if (size > 0xfffffff0) throw new Error('ZIP would be larger than 4 GB');

    const out = new Uint8Array(size);
    const view = new DataView(out.buffer);
    let p = 0;
    const u16 = (v) => {
      view.setUint16(p, v, true);
      p += 2;
    };
    const u32 = (v) => {
      view.setUint32(p, v >>> 0, true);
      p += 4;
    };

    for (const e of entries) {
      e.offset = p;
      u32(0x04034b50);
      u16(20); // version needed
      u16(0x0800); // flags: UTF-8 file names
      u16(0); // method: store
      u16(dosTime);
      u16(dosDate);
      u32(e.crc);
      u32(e.data.length);
      u32(e.data.length);
      u16(e.name.length);
      u16(0);
      out.set(e.name, p);
      p += e.name.length;
      out.set(e.data, p);
      p += e.data.length;
    }

    const cdStart = p;
    for (const e of entries) {
      u32(0x02014b50);
      u16(20); // version made by
      u16(20); // version needed
      u16(0x0800);
      u16(0);
      u16(dosTime);
      u16(dosDate);
      u32(e.crc);
      u32(e.data.length);
      u32(e.data.length);
      u16(e.name.length);
      u16(0); // extra
      u16(0); // comment
      u16(0); // disk
      u16(0); // internal attrs
      u32(0); // external attrs
      u32(e.offset);
      out.set(e.name, p);
      p += e.name.length;
    }
    const cdSize = p - cdStart;

    u32(0x06054b50);
    u16(0);
    u16(0);
    u16(entries.length);
    u16(entries.length);
    u32(cdSize);
    u32(cdStart);
    u16(0);
    return out;
  }

  return {
    slug,
    wordCount,
    estimateImages,
    splitScenes,
    extFromType,
    buildCredits,
    buildNotDownloaded,
    crc32,
    buildZip,
  };
});
