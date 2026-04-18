import { sarahPathPicker } from '../components/sarah-path-picker.js';
import { sarahInput } from '../components/sarah-input.js';
import { sarahToggle } from '../components/sarah-toggle.js';
import { PDF_PLACEHOLDERS } from './pdf-constants.js';
import type { PdfCategory } from '../../core/config-schema.js';

export function createPdfBlock(cat: PdfCategory, onChange?: () => void): HTMLElement {
  const block = document.createElement('div');
  block.className = 'pdf-block';
  block.dataset.pdfTag = cat.tag;

  const title = document.createElement('div');
  title.className = 'pdf-block-title';
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
