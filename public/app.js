/* B-Roll Finder front end. All external text is rendered with textContent. */
(function () {
  'use strict';
  const L = window.BrollLib;
  const $ = (id) => document.getElementById(id);

  // ------------------------------------------------------------ small helpers
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v);
    }
    for (const kid of kids.flat()) if (kid != null) el.append(kid);
    return el;
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const safeUrl = (u) => (/^https?:\/\//i.test(String(u || '')) ? u : '');

  // ------------------------------------------------------------ API keys (bring your own)
  const KEYS = [
    { id: 'keyGroq', store: 'broll.key.groq', header: 'x-groq-key' },
    { id: 'keyPexels', store: 'broll.key.pexels', header: 'x-pexels-key' },
    { id: 'keyPixabay', store: 'broll.key.pixabay', header: 'x-pixabay-key' },
  ];
  const REMEMBER = 'broll.remember';

  function store(kind) {
    try {
      return kind === 'local' ? window.localStorage : window.sessionStorage;
    } catch {
      return null;
    }
  }
  function readStore(kind, name) {
    try {
      return store(kind)?.getItem(name) || '';
    } catch {
      return '';
    }
  }
  function writeStore(kind, name, value) {
    try {
      const s = store(kind);
      if (!s) return;
      if (value) s.setItem(name, value);
      else s.removeItem(name);
    } catch {}
  }

  function persistKeys() {
    const remember = $('rememberKeys').checked;
    writeStore('local', REMEMBER, remember ? '1' : '');
    for (const k of KEYS) {
      const v = $(k.id).value.trim();
      writeStore('local', k.store, remember ? v : '');
      writeStore('session', k.store, remember ? '' : v);
    }
  }

  function loadKeys() {
    const remember = readStore('local', REMEMBER) === '1';
    $('rememberKeys').checked = remember;
    $('rememberChip').classList.toggle('on', remember);
    for (const k of KEYS) $(k.id).value = readStore(remember ? 'local' : 'session', k.store);
  }

  function keyHeaders() {
    const out = {};
    for (const k of KEYS) {
      const v = $(k.id).value.trim();
      if (v) out[k.header] = v;
    }
    const pass = $('passcode').value.trim();
    if (pass) out['x-passcode'] = pass;
    return out;
  }

  function updateKeyState() {
    const hasGroq = !!$('keyGroq').value.trim();
    const hasPexels = !!$('keyPexels').value.trim();
    const hasPixabay = !!$('keyPixabay').value.trim();
    const state = $('keysState');
    if (!hasGroq) {
      state.textContent = 'Groq key needed';
      state.classList.remove('ready');
    } else {
      const extra = [hasPexels && 'Pexels', hasPixabay && 'Pixabay'].filter(Boolean);
      state.textContent = 'Groq' + (extra.length ? ' + ' + extra.join(' + ') : '') + ' ready';
      state.classList.add('ready');
    }
    // Stock sources without a key cannot run, so grey them out.
    for (const [chip, has] of [
      ['srcPexels', hasPexels],
      ['srcPixabay', hasPixabay],
    ]) {
      const input = $(chip);
      const label = input.closest('label');
      input.disabled = !has;
      label.style.opacity = has ? '' : '.45';
      label.title = has ? '' : 'Add a key above to use this source';
      if (!has) {
        input.checked = false;
        label.classList.remove('on');
      }
    }
  }

  for (const k of KEYS) {
    $(k.id).addEventListener('input', () => {
      persistKeys();
      updateKeyState();
    });
  }
  $('rememberKeys').addEventListener('change', () => {
    $('rememberChip').classList.toggle('on', $('rememberKeys').checked);
    persistKeys();
  });
  $('clearKeys').addEventListener('click', () => {
    for (const k of KEYS) {
      $(k.id).value = '';
      writeStore('local', k.store, '');
      writeStore('session', k.store, '');
    }
    updateKeyState();
  });

  // ------------------------------------------------------------ chips and mode toggle
  document.querySelectorAll('.chip input[type=checkbox]').forEach((cb) => {
    if (cb.id === 'rememberKeys') return;
    cb.addEventListener('change', () => cb.closest('.chip').classList.toggle('on', cb.checked));
  });

  let mode = 'script';
  function setMode(m) {
    mode = m;
    $('modeScript').classList.toggle('active', m === 'script');
    $('modeTopic').classList.toggle('active', m === 'topic');
    $('panelScript').hidden = m !== 'script';
    $('panelTopic').hidden = m !== 'topic';
  }
  $('modeScript').addEventListener('click', () => setMode('script'));
  $('modeTopic').addEventListener('click', () => setMode('topic'));

  // ------------------------------------------------------------ progress
  const t0 = () => new Date().toLocaleTimeString([], { hour12: false });
  function log(msg, cls) {
    const line = h('div', { class: cls || '' }, h('span', { class: 't', text: t0() }), msg);
    $('log').append(line);
    $('log').scrollTop = $('log').scrollHeight;
  }
  function progress(p) {
    const v = Math.max(0, Math.min(100, Math.round(p)));
    $('pct').textContent = v + '%';
    $('barFill').style.width = v + '%';
  }

  // ------------------------------------------------------------ network
  async function api(path, body) {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...keyHeaders() },
      body: JSON.stringify(body),
    });
    let data = null;
    try {
      data = await res.json();
    } catch {}
    if (!res.ok) {
      const err = new Error((data && data.error) || `Server error ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  async function searchScene(scene, opts) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await api('/api/search', {
          queries: scene.archiveQueries,
          stockQueries: scene.stockQueries,
          sources: opts.sources,
          photos: opts.photos,
          videos: opts.videos,
        });
      } catch (e) {
        if (attempt === 0 && (e.status === 502 || e.status === 504 || !e.status)) {
          await sleep(900);
          continue;
        }
        throw e;
      }
    }
  }

  async function pool(list, size, fn) {
    let next = 0;
    const workers = Array.from({ length: Math.min(size, list.length) }, async () => {
      while (next < list.length) {
        const i = next++;
        await fn(list[i], i);
      }
    });
    await Promise.all(workers);
  }

  // ------------------------------------------------------------ state
  let current = null; // { title, script, aligned, scenes: [{ title, description, text, needed, items }] }
  const selected = new Set(); // item ids

  // ------------------------------------------------------------ main run
  async function run() {
    const btn = $('goBtn');
    const scriptText = $('scriptInput').value.trim();
    const topic = $('topicInput').value.trim();

    if (!$('keyGroq').value.trim()) {
      $('keysBox').open = true;
      $('keyGroq').focus();
      alert('Add your Groq API key first (press "Get a key" if you do not have one).');
      return;
    }
    if (mode === 'script' && scriptText.length < 200) return alert('Paste a longer script first.');
    if (mode === 'topic' && topic.length < 3) return alert('Enter a topic first.');

    const opts = {
      photos: $('optPhotos').checked,
      videos: $('optVideos').checked,
      sources: {
        commons: $('srcCommons').checked,
        loc: $('srcLoc').checked,
        pexels: $('srcPexels').checked && !!$('keyPexels').value.trim(),
        pixabay: $('srcPixabay').checked && !!$('keyPixabay').value.trim(),
      },
    };
    if (!opts.photos && !opts.videos) return alert('Tick Photos or Videos.');
    if (!Object.values(opts.sources).some(Boolean)) return alert('Pick at least one source.');

    btn.disabled = true;
    btn.textContent = '⏳ Working…';
    $('results').classList.remove('show');
    $('progress').classList.add('show');
    $('log').textContent = '';
    progress(2);

    try {
      log('Splitting into scenes…');
      const plan = await api('/api/plan', {
        mode,
        script: mode === 'script' ? scriptText : undefined,
        topic: mode === 'topic' ? topic : undefined,
        duration: Number($('durationSelect').value),
      });
      log(`${plan.scenes.length} scenes planned`, 'ok');
      progress(12);

      let parts = plan.scenes.map(() => '');
      let aligned = false;
      if (mode === 'script') {
        const r = L.splitScenes(scriptText, plan.scenes);
        parts = r.parts;
        aligned = r.aligned;
        if (!aligned) log('Could not match scene starts exactly; script split evenly instead.', 'warn');
      }

      const scenes = plan.scenes.map((s, i) => ({
        title: s.title,
        description: s.description,
        text: parts[i],
        needed: mode === 'script' ? L.estimateImages(L.wordCount(parts[i])) : 0,
        archiveQueries: s.archiveQueries,
        stockQueries: s.stockQueries,
        items: [],
      }));

      let done = 0;
      const warned = new Set();
      await pool(scenes, 1, async (scene, i) => {
        try {
          const r = await searchScene(scene, opts);
          scene.items = r.items;
          for (const e of r.errors || []) {
            const key = e.source + e.message;
            if (!warned.has(key)) {
              warned.add(key);
              log(`${e.source}: ${e.message}`, 'warn');
            }
          }
        } catch (e) {
          log(`Scene ${i + 1} search failed: ${e.message}`, 'err');
        }
        done++;
        progress(12 + (done / scenes.length) * 86);
        log(`Scene ${i + 1}: ${scene.items.length} results`);
      });

      selected.clear();
      current = {
        title: plan.title,
        script: mode === 'script' ? scriptText : '',
        aligned,
        scenes,
        videosOn: opts.videos,
      };
      progress(100);
      render();
      log('Done', 'ok');
    } catch (e) {
      if (e.status === 401) log('Wrong or missing passcode. Open "Passcode" below and enter it.', 'err');
      else log(e.message, 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = '⚡ Find images';
    }
  }

  // ------------------------------------------------------------ rendering
  function photosOf(scene) {
    return scene.items.filter((it) => it.type === 'photo');
  }

  function render() {
    const c = current;
    $('resultsTitle').textContent = c.title || 'Your B-roll pack';

    const allItems = c.scenes.flatMap((s) => s.items);
    const photoCount = allItems.filter((i) => i.type === 'photo').length;
    const verifyCount = allItems.filter((i) => i.status === 'verify').length;
    const words = L.wordCount(c.script);
    const pills = $('pills');
    pills.textContent = '';
    const pill = (n, label) => pills.append(h('div', { class: 'pill' }, h('b', { text: String(n) }), label));
    pill(c.scenes.length, 'scenes');
    pill(photoCount, 'photos found');
    if (c.script) pill(L.estimateImages(words), `images for ~${Math.round(words / 150)} min of narration`);
    if (verifyCount) pill(verifyCount, 'need a licence check');

    if (c.script) {
      $('scriptBody').textContent = c.script;
      $('scriptBlock').hidden = false;
    } else {
      $('scriptBlock').hidden = true;
    }

    const box = $('scenes');
    box.textContent = '';
    c.scenes.forEach((scene, i) => {
      const photos = photosOf(scene);
      const low = scene.needed && photos.length < scene.needed;
      const meta = [scene.description];
      if (scene.needed) meta.push(`needs about ${scene.needed} images`);
      const grid = h('div', { class: 'grid' });
      if (!scene.items.length) grid.append(h('div', { class: 'empty', text: 'Nothing found. Try other sources or adjust your wording.' }));
      for (const it of scene.items) grid.append(card(it));
      box.append(
        h(
          'div',
          { class: 'scene' },
          h(
            'div',
            { class: 'scene-head' },
            h('div', { class: 'scene-num', text: String(i + 1) }),
            h('div', { class: 'scene-info' }, h('div', { class: 'scene-title', text: scene.title }), h('div', { class: 'scene-meta', text: meta.filter(Boolean).join(' · ') })),
            h('div', { class: 'scene-count' + (low ? ' low' : ''), text: `${photos.length} photos` }),
          ),
          grid,
        ),
      );
    });

    updateZipLabel();
    $('results').classList.add('show');
    $('results').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function card(it) {
    const img = h('img', { src: safeUrl(it.thumb), alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
    img.addEventListener('error', () => img.classList.add('broken'));
    const el = h(
      'div',
      { class: 'item' + (selected.has(it.id) ? ' sel' : ''), tabindex: '0', role: 'button', 'aria-pressed': String(selected.has(it.id)) },
      img,
      h('div', { class: 'tick', text: '✓' }),
      h(
        'div',
        { class: 'info' },
        h('span', { class: 'tag' + (it.type === 'video' ? ' video' : ''), text: it.type === 'video' ? 'video' : it.source }),
        h('div', { class: 'name', text: it.title, title: it.title }),
        h('div', { class: 'by', text: it.author, title: it.author }),
        h('div', { class: 'lic ' + (it.status === 'verify' ? 'verify' : 'ok'), text: (it.status === 'verify' ? '⚠ verify · ' : '') + it.license, title: it.note || it.license }),
        safeUrl(it.page) ? h('a', { class: 'src', href: it.page, target: '_blank', rel: 'noopener noreferrer', text: 'source ↗' }) : null,
      ),
    );
    const toggle = () => {
      if (selected.has(it.id)) selected.delete(it.id);
      else selected.add(it.id);
      el.classList.toggle('sel', selected.has(it.id));
      el.setAttribute('aria-pressed', String(selected.has(it.id)));
      updateZipLabel();
    };
    el.addEventListener('click', (e) => {
      if (e.target.closest('a')) return;
      toggle();
    });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggle();
      }
    });
    return el;
  }

  // With nothing selected, take the best few per scene instead of everything.
  function defaultCap(scene) {
    return Math.max(8, Math.ceil((scene.needed || 0) * 1.3));
  }
  function chosenItems() {
    if (selected.size) {
      return current.scenes.flatMap((s, si) => s.items.filter((it) => selected.has(it.id)).map((it) => ({ it, si })));
    }
    return current.scenes.flatMap((s, si) => {
      let photos = 0;
      return s.items
        .filter((it) => it.type !== 'photo' || photos++ < defaultCap(s))
        .map((it) => ({ it, si }));
    });
  }

  function updateZipLabel() {
    if (!current) return;
    const n = chosenItems().filter(({ it }) => it.type === 'photo').length;
    $('zipBtn').textContent = `⬇ Download ZIP (${n} photo${n === 1 ? '' : 's'})`;
    $('zipNote').textContent = selected.size
      ? `${selected.size} selected. Only these go in the ZIP. Click again to deselect.`
      : 'Click images to choose specific ones. With nothing selected, the ZIP takes the best matches for each scene (about 8 or more per scene). Select images to override.';
  }

  // ------------------------------------------------------------ ZIP
  async function fetchAsset(url) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch('/api/asset?url=' + encodeURIComponent(url), { headers: keyHeaders() });
        if (res.ok) {
          const buf = new Uint8Array(await res.arrayBuffer());
          if (buf.length) return { buf, type: res.headers.get('content-type') || '' };
          throw new Error('empty file');
        }
        let msg = `HTTP ${res.status}`;
        try {
          msg = (await res.json()).error || msg;
        } catch {}
        if (res.status < 500) throw new Error(msg);
        throw new Error(msg);
      } catch (e) {
        if (attempt === 2) throw e;
        await sleep(900 * (attempt + 1)); // back off: image hosts rate-limit bursts
      }
    }
  }

  async function downloadZip() {
    if (!current) return;
    const btn = $('zipBtn');
    const picked = chosenItems();
    if (!picked.length) return alert('Nothing to download.');

    btn.disabled = true;
    const label = btn.textContent;
    const files = [];
    const assets = [];
    const skipped = [];
    const cache = new Map(); // item id -> { path }
    const photos = picked.filter(({ it }) => it.type === 'photo');
    const counters = new Map();

    try {
      for (const { it, si } of picked) {
        if (it.type !== 'photo') {
          skipped.push({ sceneLabel: `Scene ${si + 1}`, title: it.title, reason: 'Video: open the link to download', page: it.page, download: it.download, license: it.license });
        }
      }

      let finished = 0;
      await pool(photos, 3, async ({ it, si }) => {
        try {
          const { buf, type } = await fetchAsset(it.download);
          const scene = current.scenes[si];
          const n = (counters.get(si) || 0) + 1;
          counters.set(si, n);
          const folder = `scene-${String(si + 1).padStart(2, '0')}-${L.slug(scene.title, 30)}`;
          const file = `${String(n).padStart(2, '0')}-${L.slug(it.title, 40)}.${L.extFromType(type, it.download)}`;
          const path = `${folder}/${file}`;
          files.push({ name: path, data: buf });
          assets.push({ path, title: it.title, author: it.author, source: it.source, page: it.page, license: it.license, licenseUrl: it.licenseUrl, status: it.status, note: it.note, order: si * 1000 + n });
          cache.set(it.id, path);
        } catch (e) {
          skipped.push({ sceneLabel: `Scene ${si + 1}`, title: it.title, reason: `Download failed (${e.message})`, page: it.page, download: it.download, license: it.license });
        }
        finished++;
        btn.textContent = `⏳ Fetching ${finished}/${photos.length}…`;
      });

      if (!files.length) throw new Error('No images could be downloaded. Check the log and try again.');

      assets.sort((a, b) => a.order - b.order);
      files.sort((a, b) => (a.name < b.name ? -1 : 1));
      const generated = new Date().toISOString().slice(0, 10);
      const title = current.title || 'B-roll pack';
      files.push({ name: 'credits.txt', data: L.buildCredits({ title, generated, assets }) });
      if (current.script) files.push({ name: 'script.txt', data: current.script });
      files.push({
        name: 'manifest.json',
        data: JSON.stringify({ title, generated, scenes: current.scenes.map((s) => ({ title: s.title, description: s.description, archiveQueries: s.archiveQueries, stockQueries: s.stockQueries })), assets: assets.map(({ order, ...rest }) => rest) }, null, 2),
      });
      if (skipped.length) files.push({ name: 'not-downloaded.txt', data: L.buildNotDownloaded(skipped) });

      btn.textContent = '⏳ Building ZIP…';
      await sleep(30);
      const bytes = L.buildZip(files);
      const blob = new Blob([bytes], { type: 'application/zip' });
      const url = URL.createObjectURL(blob);
      const a = h('a', { href: url, download: `${L.slug(title, 50)}-broll.zip` });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      $('zipNote').textContent = `ZIP saved: ${assets.length} photos${skipped.length ? `, ${skipped.length} listed in not-downloaded.txt` : ''}. Read credits.txt before publishing.`;
    } catch (e) {
      alert(e.message);
      updateZipLabel();
    } finally {
      btn.disabled = false;
      if (!$('zipNote').textContent.startsWith('ZIP saved')) btn.textContent = label;
      else updateZipLabel2();
    }
  }
  function updateZipLabel2() {
    const n = chosenItems().filter(({ it }) => it.type === 'photo').length;
    $('zipBtn').textContent = `⬇ Download ZIP (${n} photo${n === 1 ? '' : 's'})`;
  }

  // ------------------------------------------------------------ wire up
  $('goBtn').addEventListener('click', run);
  $('zipBtn').addEventListener('click', downloadZip);

  loadKeys();
  updateKeyState();
  document.querySelectorAll('.chip input[type=checkbox]').forEach((cb) => cb.closest('.chip').classList.toggle('on', cb.checked));
  if ($('keyGroq').value.trim()) $('keysBox').open = false;
})();
