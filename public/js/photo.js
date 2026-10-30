// Free destination photos and blurbs from Wikimedia (no keys, CORS-enabled).

import { SERVICES } from './config.js';
import { politeFetch } from './net.js';

export function commonsFileFromTags(tags = {}) {
  const c = tags.wikimedia_commons;
  if (c && /^File:/i.test(c)) return c.replace(/^File:/i, '');
  const img = tags.image;
  if (img) {
    const m = img.match(/commons\.wikimedia\.org\/wiki\/(?:File|Image):([^?#]+)/i);
    if (m) return decodeURIComponent(m[1]);
  }
  return null;
}

export function parseWikipediaTag(tag) {
  if (!tag) return null;
  const m = tag.match(/^([a-z-]{2,12}):(.+)$/i);
  return m ? { lang: m[1], title: m[2] } : { lang: 'en', title: tag };
}

/**
 * Resolve { image, credit, link, extract } for a destination, or null.
 * Never throws: photos are a bonus, not a requirement.
 */
export async function findPhoto(tags = {}, { fetchJson = politeFetch, signal } = {}) {
  try {
    let wiki = parseWikipediaTag(tags.wikipedia);
    let file = commonsFileFromTags(tags);

    if ((!file || !wiki) && /^Q\d+$/.test(tags.wikidata ?? '')) {
      const url = `${SERVICES.wikidata}?action=wbgetentities&ids=${tags.wikidata}&props=claims|sitelinks&sitefilter=enwiki&format=json&origin=*`;
      const data = await fetchJson('wiki', url, { signal });
      const ent = data?.entities?.[tags.wikidata];
      const p18 = ent?.claims?.P18?.[0]?.mainsnak?.datavalue?.value;
      if (!file && typeof p18 === 'string') file = p18;
      const en = ent?.sitelinks?.enwiki?.title;
      if (!wiki && en) wiki = { lang: 'en', title: en };
    }

    let extract = null;
    let link = null;
    let image = file ? SERVICES.commonsFile(file) : null;
    if (wiki) {
      const sum = await fetchJson('wiki', SERVICES.wikipediaSummary(wiki.lang, wiki.title), { signal }).catch(() => null);
      if (sum && sum.type !== 'disambiguation') {
        extract = sum.extract ?? null;
        link = sum.content_urls?.mobile?.page ?? sum.content_urls?.desktop?.page ?? null;
        if (!image) image = sum.originalimage?.source ?? sum.thumbnail?.source ?? null;
      }
    }
    if (!image && !extract) return null;
    return {
      image,
      extract: extract && extract.length > 280 ? `${extract.slice(0, 277).trimEnd()}…` : extract,
      link: link ?? (file ? `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(file)}` : null),
      credit: wiki ? 'Wikipedia / Wikimedia Commons' : 'Wikimedia Commons',
    };
  } catch {
    return null;
  }
}
