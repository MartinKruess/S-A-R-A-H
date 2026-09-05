/** Versioned disclosures are consent identity, not provider-retention guarantees. */
export const PERPLEXITY_STORAGE_DISCLOSURE = Object.freeze({
  version: 'perplexity-storage-v1',
  text: 'Perplexity speichert Auftrag und Antwort für diesen Hintergrundauftrag beim Anbieter. Sarah kann den Status später abrufen. Eine feste Löschfrist oder Löschung durch Sarah ist für diese Anbindung derzeit nicht bestätigt.',
});

export const PERPLEXITY_PAID_PROBE = Object.freeze({
  version: 'perplexity-probe-v1',
  text: 'Kostenpflichtigen Verbindungstest erlauben: eine kurze API-Anfrage ohne Tools, höchstens 8 Ausgabetokens und ein Modellschritt. Auch ein Abbruch kann Kosten verursachen; dies ist kein Geldlimit.',
});
