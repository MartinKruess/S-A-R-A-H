import { sarahInput } from '../../../components/sarah-input.js';
import { sarahSelect } from '../../../components/sarah-select.js';
import { sarahButton } from '../../../components/sarah-button.js';
import { showSaved, createSectionHeader, save, createHint } from '../../../shared/settings-utils.js';
import type { SarahConfig, CustomCommand } from '../../../../core/config-schema.js';
import { BUILTIN_COMMANDS, RESERVED_BUILTIN_COMMANDS } from '../../../../services/commands/builtin-commands.js';
import { createSettingsSubtabs } from '../../../shared/settings-subtabs.js';

const ALLOWED_PTT_KEYS = [
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6',
  'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
] as const;

function isAllowedPttKey(key: string): key is typeof ALLOWED_PTT_KEYS[number] {
  return ALLOWED_PTT_KEYS.some((candidate) => candidate === key);
}

function createCommandRow(cmd: { command: string; description: string }, deletable: boolean, onDelete?: () => void): HTMLElement {
  const row = document.createElement('div');
  row.className = 'cmd-row';

  const cmdLabel = document.createElement('span');
  cmdLabel.className = 'cmd-label';
  cmdLabel.textContent = cmd.command;
  row.appendChild(cmdLabel);

  const desc = document.createElement('span');
  desc.className = 'cmd-desc';
  desc.textContent = cmd.description;
  row.appendChild(desc);

  if (deletable && onDelete) {
    const delBtn = document.createElement('button');
    delBtn.className = 'cmd-delete';
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

  const { header, feedback } = createSectionHeader('Bedienung');
  section.appendChild(header);

  const controlPanel = document.createElement('div');
  controlPanel.className = 'settings-control-stack';
  const commandsPanel = document.createElement('div');

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
  controlPanel.appendChild(voiceModeSelect);

  // Push-to-Talk Taste (only visible in push-to-talk mode)
  const hotkeyWrapper = sarahInput({
    label: 'Push-to-Talk Taste',
    value: controls.pushToTalkKey || 'F9',
    placeholder: 'Taste drücken...',
  });
  hotkeyWrapper.style.display = (controls.voiceMode === 'push-to-talk') ? '' : 'none';

  // Configure hotkey capture via public API
  hotkeyWrapper.setReadOnly(true);
  hotkeyWrapper.onKeydown((e: KeyboardEvent) => {
    e.preventDefault();
    const key = e.key;
    if (!isAllowedPttKey(key)) return;
    hotkeyWrapper.value = key;
    save('controls', { ...controls, pushToTalkKey: key });
    showSaved(feedback);
  });
  controlPanel.appendChild(hotkeyWrapper);

  // Quiet mode duration
  const quietModeGroup = document.createElement('div');
  quietModeGroup.className = 'settings-field-group';
  quietModeGroup.appendChild(sarahSelect({
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
  quietModeGroup.appendChild(createHint('Mit /quietmode aktivierst du den Ruhemodus. Sarah hört nicht zu und reagiert nicht, bis die Zeit abläuft oder du erneut /quietmode eingibst.'));
  controlPanel.appendChild(quietModeGroup);

  const cmdList = document.createElement('div');
  cmdList.className = 'cmd-list';

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
  commandsPanel.appendChild(cmdList);

  // Add custom command
  const addArea = document.createElement('div');
  addArea.className = 'cmd-add';

  const cmdInput = sarahInput({
    label: 'Command',
    placeholder: '/meincommand',
  });
  cmdInput.classList.add('cmd-add-input');

  const promptInput = sarahInput({
    label: 'Prompt',
    placeholder: 'Was soll Sarah tun?',
  });
  promptInput.classList.add('cmd-add-prompt');

  const addBtn = sarahButton({
    label: 'Hinzufügen',
    variant: 'secondary',
    onClick: () => {
      let cmd = cmdInput.value.trim();
      const prompt = promptInput.value.trim();
      if (!cmd || !prompt) return;
      if (!cmd.startsWith('/')) cmd = '/' + cmd;
      cmd = cmd.toLowerCase();
      if (!/^\/[a-z0-9_-]{1,50}$/i.test(cmd)) return;
      if (RESERVED_BUILTIN_COMMANDS.has(cmd)) return;
      if (customCmds.some(c => c.command.trim().toLowerCase() === cmd)) return;
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
  commandsPanel.appendChild(addArea);

  section.appendChild(createSettingsSubtabs([
    { id: 'control-settings', label: 'Steuerung', content: controlPanel },
    { id: 'slash-commands', label: 'Slash-Commands', content: commandsPanel },
  ]));

  return section;
}
