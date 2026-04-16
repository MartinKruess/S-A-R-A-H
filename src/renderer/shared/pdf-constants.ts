export const PDF_CATEGORY_OPTIONS = [
  { value: 'Gewerblich', label: 'Gewerblich', icon: '🏢' },
  { value: 'Steuern', label: 'Steuern', icon: '🧾' },
  { value: 'Präsentationen', label: 'Präsentationen', icon: '📊' },
  { value: 'Bewerbung', label: 'Bewerbung', icon: '📨' },
  { value: 'Zertifikate', label: 'Zertifikate', icon: '🏅' },
  { value: 'Verträge', label: 'Verträge', icon: '📝' },
  { value: 'Kontoauszüge', label: 'Kontoauszüge', icon: '🏦' },
];

export const PDF_PLACEHOLDERS: Record<string, string> = {
  'Kontoauszüge': 'Bankname_MM_YY',
  'Bewerbung': 'Firmenname_Stelle',
  'Steuern': 'Jahr_Steuerart',
  'Verträge': 'Anbieter_Vertragsart',
  'Zertifikate': 'Aussteller_Thema_Jahr',
  'Gewerblich': 'Firma_Dokumenttyp',
  'Präsentationen': 'Thema_Datum',
};
