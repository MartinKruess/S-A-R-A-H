import { sarahPathPicker } from '../components/sarah-path-picker.js';
import { sarahInput } from '../components/sarah-input.js';
import { sarahToggle } from '../components/sarah-toggle.js';
import { PDF_PLACEHOLDERS } from './pdf-constants.js';
import type { PdfCategory } from '../../core/config-schema.js';

export function createPdfBlock(cat: PdfCategory, onChange?: () => void): HTMLElement {
  const block = document.createElement('div');
  block.style.cssText = 'padding: var(--sarah-space-md); background: var(--sarah-bg-surface); border: 1px solid var(--sarah-border); border-radius: var(--sarah-radius-md); display: flex; flex-direction: column; gap: var(--sarah-space-sm);';
  block.dataset.pdfTag = cat.tag;

  const title = document.createElement('div');
  title.style.cssText = 'font-size: var(--sarah-font-size-sm); color: var(--sarah-accent); font-weight: 500; letter-spacing: 0.03em;';
  title.textContent = cat.tag;
  block.appendChild(title);

  block.appendChild(sarahPathPicker({
    label: 'Ordner',
    placeholder: 'Ordner auswählen...',
    value: cat.folder,
    onChange: (value) => { cat.folder = value; onChange?.(); },
  }));

  block.appendChild(sarahInput({
    label: 'Benennungsschema (optional)',
    placeholder: PDF_PLACEHOLDERS[cat.tag] ?? 'Beschreibung_Datum',
    value: cat.pattern,
    onChange: (value) => { cat.pattern = value; onChange?.(); },
  }));

  block.appendChild(sarahToggle({
    label: 'An bestehenden Dateien orientieren',
    checked: cat.inferFromExisting,
    onChange: (value) => { cat.inferFromExisting = value; onChange?.(); },
  }));

  return block;
}
