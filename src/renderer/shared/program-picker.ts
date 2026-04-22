import { sarahTagSelect } from '../components/sarah-tag-select.js';
import { sarahPathPicker } from '../components/sarah-path-picker.js';
import { createProgramDetector } from './program-detection.js';
import { mergeOptions, reconstructEntries } from './program-picker-logic.js';
import { getSarah } from './settings-utils.js';
import type { ProgramEntry } from '../../core/config-schema.js';

export interface ProgramPickerProps {
  initialSelected: ProgramEntry[];
  onChange: (entries: ProgramEntry[]) => void;
  includeFolderScanners?: boolean;
  initialExtraFolder?: string;
  initialGamesFolder?: string;
  showGamesFolder?: boolean;
  onFolderChange?: (kind: 'extra' | 'games', path: string) => void;
}

const CSS = `
  .program-picker-hint {
    font-size: var(--sarah-font-size-sm);
    color: var(--sarah-text-muted);
    margin-top: var(--sarah-space-xs);
  }
  .program-picker-scan-status {
    padding: 4px 0;
    color: var(--sarah-accent);
    font-size: var(--sarah-font-size-sm);
    min-height: 1.2em;
  }
  .program-picker-folders {
    display: grid;
    grid-template-columns: 1fr;
    gap: var(--sarah-space-md);
    margin-top: var(--sarah-space-md);
  }
  @media (min-width: 600px) {
    .program-picker-folders {
      grid-template-columns: 1fr 1fr;
    }
  }
`;

export function createProgramPicker(props: ProgramPickerProps): HTMLElement {
  const detector = createProgramDetector();
  let currentSelected: ProgramEntry[] = [...props.initialSelected];

  const container = document.createElement('div');
  const style = document.createElement('style');
  style.textContent = CSS;
  container.appendChild(style);

  const placeholder = document.createElement('div');
  placeholder.textContent = 'Lade Programme...';
  placeholder.style.color = 'var(--sarah-text-muted)';
  placeholder.style.fontSize = 'var(--sarah-font-size-sm)';
  container.appendChild(placeholder);

  const scanStatus = document.createElement('div');
  scanStatus.className = 'program-picker-scan-status';
  container.appendChild(scanStatus);

  let tagSelectEl: ReturnType<typeof sarahTagSelect> | null = null;
  let currentOptions: ReturnType<typeof detector.buildOptions> = [];

  const notifyChange = (names: string[]): void => {
    const detectedEntries = Array.from(currentOptions)
      .map(o => detector.buildProgramEntry(o.value))
      .filter(e => e.source === 'detected');
    currentSelected = reconstructEntries(names, detectedEntries, currentSelected, detector.buildProgramEntry);
    props.onChange(currentSelected);
  };

  const mountTagSelect = (): void => {
    const merged = mergeOptions(currentOptions, currentSelected);
    const el = sarahTagSelect({
      label: 'Welche Programme nutzt du oft?',
      options: merged,
      selected: currentSelected.map(e => e.name),
      allowCustom: true,
      onChange: notifyChange,
    });
    if (tagSelectEl) {
      tagSelectEl.replaceWith(el);
    } else {
      placeholder.replaceWith(el);
    }
    tagSelectEl = el;
  };

  getSarah().detectPrograms().then((programs: ProgramEntry[]) => {
    detector.registerDetected(programs);
    currentOptions = detector.buildOptions(programs);
    mountTagSelect();
  }).catch(() => {
    currentOptions = [];
    mountTagSelect();
  });

  if (props.includeFolderScanners) {
    const folders = document.createElement('div');
    folders.className = 'program-picker-folders';

    const runScan = (folderPath: string, label: string): void => {
      scanStatus.textContent = `Scanne ${label}...`;
      getSarah().scanFolderExes(folderPath).then((programs: ProgramEntry[]) => {
        scanStatus.textContent = programs.length > 0
          ? `${programs.length} ${label} gefunden in ${folderPath}`
          : `Keine ${label} gefunden`;
        detector.addScannedPrograms(programs, currentOptions);
        mountTagSelect();
        setTimeout(() => { scanStatus.textContent = ''; }, 4000);
      }).catch(() => { scanStatus.textContent = ''; });
    };

    folders.appendChild(sarahPathPicker({
      label: 'Weitere Programme (Ordner scannen)',
      placeholder: 'z.B. E:\\ oder D:\\Programme...',
      value: props.initialExtraFolder ?? '',
      onChange: (value) => {
        props.onFolderChange?.('extra', value);
        if (value) runScan(value, 'Programme');
      },
    }));

    if (props.showGamesFolder) {
      folders.appendChild(sarahPathPicker({
        label: 'Games-Ordner (automatisch scannen)',
        placeholder: 'z.B. D:\\Games...',
        value: props.initialGamesFolder ?? '',
        onChange: (value) => {
          props.onFolderChange?.('games', value);
          if (value) runScan(value, 'Games');
        },
      }));
    }
    container.appendChild(folders);
  }

  return container;
}
