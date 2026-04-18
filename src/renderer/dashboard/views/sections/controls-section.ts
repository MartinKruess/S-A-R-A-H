import { sarahInput } from '../../../components/sarah-input.js';
import { sarahSelect } from '../../../components/sarah-select.js';
import { sarahButton } from '../../../components/sarah-button.js';
import { showSaved, createSectionHeader, save, createSpacer, createHint } from '../../../shared/settings-utils.js';
import type { SarahConfig, CustomCommand } from '../../../../core/config-schema.js';

const BUILTIN_COMMANDS = [
  { command: '/anonymous', description: 'Nachricht wird nach der Session vergessen' },
  { command: '/showcontext', description: 'Zeigt alles was Sarah über dich weiß' },
  { command: '/quietmode', description: 'Ruhemodus ein/aus' },
];

function createCommandRow(cmd: { command: string; description: string }, deletable: boolean, onDelete?: () => void): HTMLElement {
  const row = document.createElement('div');
  row.style.cssText = 'display: flex; align-items: center; gap: var(--sarah-space-sm); padding: var(--sarah-space-xs) var(--sarah-space-sm); background: var(--sarah-bg-surface); border: 1px solid var(--sarah-border); border-radius: var(--sarah-radius-md);';

  const cmdLabel = document.createElement('span');
  cmdLabel.style.cssText = 'color: var(--sarah-accent); font-family: monospace; font-size: var(--sarah-font-size-sm); min-width: 120px;';
  cmdLabel.textContent = cmd.command;
  row.appendChild(cmdLabel);

  const desc = document.createElement('span');
  desc.style.cssText = 'flex: 1; font-size: var(--sarah-font-size-sm); color: var(--sarah-text-secondary);';
  desc.textContent = cmd.description;
  row.appendChild(desc);

  if (deletable && onDelete) {
    const delBtn = document.createElement('button');
    delBtn.style.cssText = 'background: none; border: none; color: var(--sarah-text-muted); cursor: pointer; font-size: var(--sarah-font-size-sm); padding: 2px 6px;';
    delBtn.textContent = '✕';
    delBtn.addEventListener('click', onDelete);
    row.appendChild(delBtn);
  }

  return row;
}

export function createControlsSection(config: SarahConfig): HTMLElement {
  const controls = { ...config.controls };
  const section = document.createElement('div');
  section.className = 'settings-section';

  const { header, feedback } = createSectionHeader('Steuerung');
  section.appendChild(header);

  // Voice mode
  const voiceModeSelect = sarahSelect({
    label: 'Sprachsteuerung',
    options: [
      { value: 'off', label: 'Aus' },
      { value: 'push-to-talk', label: 'Push-to-Talk' },
    ],
    value: controls.voiceMode || 'off',
    onChange: (val) => {
      controls.voiceMode = val as typeof controls.voiceMode;
      hotkeyWrapper.style.display = (val === 'push-to-talk') ? '' : 'none';
      save('controls', controls);
      showSaved(feedback);
    },
  });
  section.appendChild(voiceModeSelect);

  // Push-to-Talk Taste (only visible in push-to-talk mode)
  const hotkeyWrapper = sarahInput({
    label: 'Push-to-Talk Taste',
    value: controls.pushToTalkKey || 'F9',
    placeholder: 'Taste drücken...',
  });
  hotkeyWrapper.style.display = (controls.voiceMode === 'push-to-talk') ? '' : 'none';

  // Configure hotkey capture via public API
  hotkeyWrapper.setReadOnly(true);
  const ALLOWED_KEYS = ['F1','F2','F3','F4','F5','F6','F7','F8','F9','F10','F11','F12'];
  hotkeyWrapper.onKeydown((e: KeyboardEvent) => {
    e.preventDefault();
    const key = e.key;
    if (!ALLOWED_KEYS.includes(key)) return;
    hotkeyWrapper.value = key;
    save('controls', { ...controls, pushToTalkKey: key });
    showSaved(feedback);
  });
  section.appendChild(hotkeyWrapper);
  section.appendChild(createSpacer());

  // Quiet mode duration
  section.appendChild(sarahSelect({
    label: 'Ruhemodus-Dauer',
    options: [
      { value: '15', label: '15 Minuten' },
      { value: '30', label: '30 Minuten' },
      { value: '60', label: '60 Minuten' },
      { value: '120', label: '2 Stunden' },
    ],
    value: String(controls.quietModeDuration ?? 60),
    onChange: (val) => { controls.quietModeDuration = parseInt(val, 10); save('controls', controls); showSaved(feedback); },
  }));
  section.appendChild(createHint('Mit /quietmode aktivierst du den Ruhemodus. Sarah hört nicht zu und reagiert nicht, bis die Zeit abläuft oder du erneut /quietmode eingibst.'));

  // Performance profile
  const llm = { ...config.llm };
  section.appendChild(createSpacer());

  section.appendChild(sarahSelect({
    label: 'GPU-Leistungsprofil',
    options: [
      { value: 'leistung', label: 'Leistung — Maximale GPU-Nutzung' },
      { value: 'schnell', label: 'Schnell — Hohe GPU-Nutzung' },
      { value: 'normal', label: 'Normal — Ausgewogen' },
      { value: 'sparsam', label: 'Sparsam — Weniger GPU, mehr CPU' },
    ],
    value: llm.performanceProfile || 'normal',
    onChange: (val) => {
      llm.performanceProfile = val as typeof llm.performanceProfile;
      save('llm', llm);
      showSaved(feedback);
    },
  }));
  section.appendChild(createHint('Steuert wie viele GPU-Layer für das große Sprachmodell verwendet werden. Höhere Stufen sind schneller, belegen aber mehr VRAM.'));
  section.appendChild(createSpacer('lg'));

  // Slash Commands header
  const cmdTitle = document.createElement('div');
  cmdTitle.style.cssText = 'font-size: var(--sarah-font-size-sm); color: var(--sarah-accent); text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: var(--sarah-space-sm);';
  cmdTitle.textContent = 'Slash-Commands';
  section.appendChild(cmdTitle);

  const cmdList = document.createElement('div');
  cmdList.style.cssText = 'display: flex; flex-direction: column; gap: var(--sarah-space-xs);';

  // Built-in commands
  for (const cmd of BUILTIN_COMMANDS) {
    cmdList.appendChild(createCommandRow(cmd, false));
  }

  // Custom commands
  const customCmds: CustomCommand[] = controls.customCommands || [];

  function renderCustomCommands(): void {
    cmdList.querySelectorAll('[data-custom-cmd]').forEach(el => el.remove());
    for (let i = 0; i < customCmds.length; i++) {
      const cmd = customCmds[i];
      const row = createCommandRow({ command: cmd.command, description: cmd.prompt }, true, () => {
        customCmds.splice(i, 1);
        controls.customCommands = customCmds;
        save('controls', controls);
        showSaved(feedback);
        renderCustomCommands();
      });
      row.dataset.customCmd = 'true';
      cmdList.appendChild(row);
    }
  }

  renderCustomCommands();
  section.appendChild(cmdList);

  // Add custom command
  const addArea = document.createElement('div');
  addArea.style.cssText = 'display: flex; gap: var(--sarah-space-sm); align-items: flex-end; margin-top: var(--sarah-space-md);';

  const cmdInput = sarahInput({
    label: 'Command',
    placeholder: '/meincommand',
  });
  cmdInput.style.flex = '0 0 140px';

  const promptInput = sarahInput({
    label: 'Prompt',
    placeholder: 'Was soll Sarah tun?',
  });
  promptInput.style.flex = '1';

  const addBtn = sarahButton({
    label: 'Hinzufügen',
    variant: 'secondary',
    onClick: () => {
      let cmd = cmdInput.value.trim();
      const prompt = promptInput.value.trim();
      if (!cmd || !prompt) return;
      if (!cmd.startsWith('/')) cmd = '/' + cmd;
      if (BUILTIN_COMMANDS.some(b => b.command === cmd)) return;
      if (customCmds.some(c => c.command === cmd)) return;
      customCmds.push({ command: cmd, prompt });
      controls.customCommands = customCmds;
      save('controls', controls);
      showSaved(feedback);
      cmdInput.value = '';
      promptInput.value = '';
      renderCustomCommands();
    },
  });

  addArea.appendChild(cmdInput);
  addArea.appendChild(promptInput);
  addArea.appendChild(addBtn);
  section.appendChild(addArea);

  return section;
}
