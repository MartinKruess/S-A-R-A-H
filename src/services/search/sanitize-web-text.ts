// Container 2 (Spec §6): every string that leaves the browser passes this gate.
import type { SearchResult } from './search-provider.interface.js';

const MAX_TITLE = 150;
const MAX_SNIPPET = 300;
const MAX_RESULTS = 8;
const TOTAL_BUDGET = 2000;

const INVISIBLES = /[​-‏‪-‮⁦-⁩﻿]/g;

const ENTITIES: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ',
};

function decodeEntitiesOnce(s: string): string {
  return s.replace(/&(?:amp|lt|gt|quot|#39|nbsp);|&#(\d+);/g, (m, code?: string) => {
    if (code) return String.fromCodePoint(Number(code));
    return ENTITIES[m] ?? m;
  });
}

function cleanText(s: string, max: number): string {
  const cleaned = decodeEntitiesOnce(s.normalize('NFC').replace(INVISIBLES, ''))
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.slice(0, max);
}

function isValidHttpUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Pure, never throws. Output is data – it is never parsed for tags downstream. */
export function sanitizeResults(raw: SearchResult[]): SearchResult[] {
  const out: SearchResult[] = [];
  let budget = TOTAL_BUDGET;
  for (const entry of raw) {
    if (out.length >= MAX_RESULTS) break;
    const title = cleanText(entry.title, MAX_TITLE);
    const snippet = cleanText(entry.snippet, MAX_SNIPPET);
    if (!title || !isValidHttpUrl(entry.url)) continue;
    const cost = title.length + snippet.length;
    if (cost > budget) break;
    budget -= cost;
    out.push({ title, url: entry.url, snippet });
  }
  return out;
}
