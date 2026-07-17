export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** Backend implementation arrives with the Abo-Backend – interface is the seam. */
export interface SearchProvider {
  search(query: string, signal: AbortSignal): Promise<SearchResult[]>;
}
