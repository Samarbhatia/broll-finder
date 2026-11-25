// Image/video sources. Each search function returns an array of normalized items:
// { id, source, type, title, author, license, licenseUrl, status, note, page,
//   thumb, download, date? }
//   status: 'ok'     -> licence is public domain / CC0 / CC BY / vendor free licence
//           'verify' -> needs a human check (ShareAlike, restrictions, rights not stated)
import { timedFetch, stripTags, shortHash } from './common.mjs';

const PD_RE = /public domain|^pd[-\s]|^pd$|cc0|pdm|no known copyright/i;

// ---------------------------------------------------------------- Wikimedia Commons
export async function searchCommons(query, limit = 4) {
  const params = new URLSearchParams({
    action: 'query',
    generator: 'search',
    gsrnamespace: '6', // File: namespace on Commons
    gsrsearch: `${query} filetype:bitmap`,
    gsrlimit: String(limit),
    prop: 'imageinfo',
    iiprop: 'url|extmetadata|mime|size|thumbmime',
    iiurlwidth: '1600',
    iiextmetadatafilter:
      'LicenseShortName|LicenseUrl|Artist|Credit|NonFree|Restrictions|ObjectName|AttributionRequired',
    format: 'json',
    formatversion: '2',
  });
  const res = await timedFetch(`https://commons.wikimedia.org/w/api.php?${params}`);
  if (!res.ok) throw new Error(`Commons HTTP ${res.status}`);
  const data = await res.json();
  const pages = data?.query?.pages || [];
  const out = [];
  for (const pg of pages) {
    const info = pg.imageinfo?.[0];
    if (!info || !info.thumburl) continue;
    const md = info.extmetadata || {};
    const val = (k) => stripTags(md[k]?.value ?? '');
    const license = val('LicenseShortName');
    if (!license) continue; // unknown licence: skip rather than guess
    if (/^(true|yes)$/i.test(val('NonFree')) || /fair use|non-?free/i.test(license)) continue;
    const mime = info.thumbmime || info.mime || '';
    if (!/^image\/(jpeg|png|webp|gif)$/.test(mime)) continue;

    const restrictions = val('Restrictions');
    const shareAlike = /\bsa\b|gfdl|share.?alike/i.test(license);
    const notes = [];
    if (restrictions) notes.push(`Restrictions flagged: ${restrictions}`);
    if (shareAlike) notes.push('ShareAlike/GFDL licence: check the terms before using in a video');
    const needsCredit = !PD_RE.test(license);
    if (needsCredit) notes.push('Credit the author and licence');

    out.push({
      id: `commons-${pg.pageid}`,
      source: 'Wikimedia Commons',
      type: 'photo',
      title: (val('ObjectName') || (pg.title || '').replace(/^File:/, '').replace(/\.[a-z0-9]+$/i, '')).replace(/_/g, ' '),
      author: val('Artist') || val('Credit') || 'Unknown',
      license,
      licenseUrl: val('LicenseUrl'),
      status: restrictions || shareAlike ? 'verify' : 'ok',
      note: notes.join('. '),
      page: info.descriptionurl || `https://commons.wikimedia.org/?curid=${pg.pageid}`,
      thumb: info.thumburl,
      download: info.thumburl, // 1600px rendition: small enough to proxy
    });
  }
  return out;
}

// ---------------------------------------------------------------- Library of Congress
function locUrl(u) {
  let x = String(u).split('#')[0];
  if (x.startsWith('//')) x = `https:${x}`;
  return x.replace(/^http:\/\//, 'https://');
}

export async function searchLoc(query, limit = 3) {
  const params = new URLSearchParams({
    q: query,
    fo: 'json',
    c: String(limit),
    at: 'results',
    fa: 'online-format:image',
  });
  const res = await timedFetch(`https://www.loc.gov/photos/?${params}`);
  if (!res.ok) throw new Error(`LOC HTTP ${res.status}`);
  const data = await res.json();
  const out = [];
  for (const item of data?.results || []) {
    if (item.access_restricted) continue;
    const imgs = (Array.isArray(item.image_url) ? item.image_url : []).filter((u) =>
      /\.(jpe?g|png|gif)(#|$)/i.test(u),
    );
    if (!imgs.length) continue;
    const rightsText = [item.rights, item.rights_information, item.rights_advisory]
      .flat()
      .filter(Boolean)
      .map(stripTags)
      .join(' ')
      .slice(0, 300);
    const clear = /no known restrictions|public domain|no known copyright/i.test(rightsText);
    const contributors = Array.isArray(item.contributor) ? item.contributor.slice(0, 2).join('; ') : '';
    out.push({
      id: `loc-${shortHash(item.id || item.url || imgs[0])}`,
      source: 'Library of Congress',
      type: 'photo',
      title: stripTags(Array.isArray(item.title) ? item.title[0] : item.title || 'Untitled'),
      author: stripTags(contributors) || 'Library of Congress',
      license: rightsText || "Rights not stated in search data: check the item's page",
      licenseUrl: '',
      status: clear ? 'ok' : 'verify',
      note: clear ? "LOC's own rights statement; not a legal guarantee" : 'Check the rights statement on the LOC page',
      page: item.url || item.id || '',
      thumb: locUrl(imgs[0]),
      download: locUrl(imgs[imgs.length - 1]), // last entry is the largest public file
      date: item.date ? String(item.date) : undefined,
    });
  }
  return out;
}

// ---------------------------------------------------------------- Pexels
export async function searchPexels(query, { photos = true, videos = false, key = '' } = {}, limit = 2) {
  if (!key) return [];
  const headers = { Authorization: key };
  const jobs = [];
  if (photos) {
    jobs.push(
      timedFetch(
        `https://api.pexels.com/v1/search?${new URLSearchParams({ query, per_page: String(limit), orientation: 'landscape' })}`,
        { headers },
      ).then(async (r) => {
        if (!r.ok) throw new Error(`Pexels HTTP ${r.status}`);
        const d = await r.json();
        return (d.photos || []).map((p) => ({
          id: `pexels-p-${p.id}`,
          source: 'Pexels',
          type: 'photo',
          title: stripTags(p.alt || 'Pexels photo'),
          author: stripTags(p.photographer || 'Unknown'),
          license: 'Pexels License',
          licenseUrl: 'https://www.pexels.com/license/',
          status: 'ok',
          note: 'Stock image: generic, not a record of a specific historical event',
          page: p.url,
          thumb: p.src?.medium,
          download: p.src?.large2x || p.src?.large || p.src?.original,
        }));
      }),
    );
  }
  if (videos) {
    jobs.push(
      timedFetch(
        `https://api.pexels.com/videos/search?${new URLSearchParams({ query, per_page: String(limit), orientation: 'landscape' })}`,
        { headers },
      ).then(async (r) => {
        if (!r.ok) throw new Error(`Pexels video HTTP ${r.status}`);
        const d = await r.json();
        return (d.videos || []).map((v) => {
          const file = v.video_files?.find((f) => f.quality === 'hd') || v.video_files?.[0];
          return {
            id: `pexels-v-${v.id}`,
            source: 'Pexels',
            type: 'video',
            title: 'Pexels video',
            author: stripTags(v.user?.name || 'Unknown'),
            license: 'Pexels License',
            licenseUrl: 'https://www.pexels.com/license/',
            status: 'ok',
            note: 'Video: listed as a link in the ZIP (too large to bundle)',
            page: v.url,
            thumb: v.image,
            download: file?.link,
          };
        });
      }),
    );
  }
  const settled = await Promise.allSettled(jobs);
  const items = settled.flatMap((s) => (s.status === 'fulfilled' ? s.value : []));
  if (!items.length && settled.every((s) => s.status === 'rejected')) throw settled[0].reason;
  return items.filter((i) => i.thumb && i.download);
}

// ---------------------------------------------------------------- Pixabay
export async function searchPixabay(query, { photos = true, videos = false, key = '' } = {}, limit = 2) {
  if (!key) return [];
  const perPage = String(Math.max(3, limit)); // Pixabay's minimum per_page is 3
  const jobs = [];
  if (photos) {
    jobs.push(
      timedFetch(
        `https://pixabay.com/api/?${new URLSearchParams({ key, q: query, per_page: perPage, image_type: 'photo', orientation: 'horizontal', safesearch: 'true' })}`,
      ).then(async (r) => {
        if (!r.ok) throw new Error(`Pixabay HTTP ${r.status}`);
        const d = await r.json();
        return (d.hits || []).slice(0, limit).map((p) => ({
          id: `pixabay-p-${p.id}`,
          source: 'Pixabay',
          type: 'photo',
          title: stripTags(p.tags || 'Pixabay photo'),
          author: stripTags(p.user || 'Unknown'),
          license: 'Pixabay Content License',
          licenseUrl: 'https://pixabay.com/service/license-summary/',
          status: 'ok',
          note: 'Stock image: generic, not a record of a specific historical event',
          page: p.pageURL,
          thumb: p.webformatURL,
          download: p.largeImageURL,
        }));
      }),
    );
  }
  if (videos) {
    jobs.push(
      timedFetch(
        `https://pixabay.com/api/videos/?${new URLSearchParams({ key, q: query, per_page: perPage, safesearch: 'true' })}`,
      ).then(async (r) => {
        if (!r.ok) throw new Error(`Pixabay video HTTP ${r.status}`);
        const d = await r.json();
        return (d.hits || []).slice(0, limit).map((v) => ({
          id: `pixabay-v-${v.id}`,
          source: 'Pixabay',
          type: 'video',
          title: stripTags(v.tags || 'Pixabay video'),
          author: stripTags(v.user || 'Unknown'),
          license: 'Pixabay Content License',
          licenseUrl: 'https://pixabay.com/service/license-summary/',
          status: 'ok',
          note: 'Video: listed as a link in the ZIP (too large to bundle)',
          page: v.pageURL,
          thumb: v.videos?.medium?.thumbnail || v.videos?.tiny?.thumbnail,
          download: v.videos?.medium?.url || v.videos?.tiny?.url,
        }));
      }),
    );
  }
  const settled = await Promise.allSettled(jobs);
  const items = settled.flatMap((s) => (s.status === 'fulfilled' ? s.value : []));
  if (!items.length && settled.every((s) => s.status === 'rejected')) throw settled[0].reason;
  return items.filter((i) => i.thumb && i.download);
}
