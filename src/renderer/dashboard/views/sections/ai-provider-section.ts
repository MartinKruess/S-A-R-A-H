import { sarahButton } from '../../../components/sarah-button.js';
import type {
  AiProviderCatalogEntry,
  AiProviderHubSnapshot,
  AiProviderRole,
  AiRoleBinding,
} from '../../../../core/ai-provider-contract.js';
import { getSarah } from '../../../shared/window-global.js';
import {
  AI_ROLE_LABELS,
  bindingOptionKey,
  buildAcknowledgeWarningsInput,
  buildReplaceBindingsInput,
  buildSaveApiKeyInput,
  compatibleBindingOptions,
  deleteAiConnection,
  moveRoleBinding,
  orderRoleBindings,
  providerWarnings,
  requiresWarningAcknowledgement,
  submitApiKey,
  submitWarningAcknowledgement,
  submitRoleBindings,
  toAiProviderCardView,
  type AiBindingOption,
  type AiUiActionOutcome,
} from './ai-provider-section-logic.js';

const ROLE_ORDER: readonly AiProviderRole[] = ['text', 'coding', 'research'];

/** Renders the local-only AI provider configuration and inactive role bindings. */
export function createAiProviderSection(): HTMLElement {
  const api = getSarah();
  const root = document.createElement('section');
  root.className = 'ai-provider-hub';

  const title = document.createElement('h3');
  title.className = 'settings-secondary-heading ai-provider-title';
  title.textContent = 'KI-Anbieter';
  root.appendChild(title);

  const intro = document.createElement('div');
  intro.className = 'settings-hint';
  intro.textContent = 'Hinterlege API-Schlüssel und bereite die spätere Auswahl externer KI-Funktionen vor.';
  root.appendChild(intro);

  const feedback = document.createElement('div');
  feedback.className = 'ai-provider-feedback';
  feedback.hidden = true;
  root.appendChild(feedback);

  const content = document.createElement('div');
  content.className = 'ai-provider-content';
  root.appendChild(content);

  function showFeedback(message: string, ok = false): void {
    feedback.textContent = message;
    feedback.className = `ai-provider-feedback ai-provider-feedback--${ok ? 'success' : 'error'}`;
    feedback.hidden = false;
  }

  function applyOutcome(outcome: AiUiActionOutcome): void {
    if (outcome.snapshot) render(outcome.snapshot);
    showFeedback(outcome.message, outcome.ok);
  }

  function render(snapshot: AiProviderHubSnapshot): void {
    content.replaceChildren();
    const cards = document.createElement('div');
    cards.className = 'ai-provider-cards';
    for (const provider of snapshot.catalog) {
      cards.appendChild(createProviderCard(snapshot, provider));
    }
    content.appendChild(cards);
    content.appendChild(createBindingsEditor(snapshot));
  }

  function createProviderCard(
    snapshot: AiProviderHubSnapshot,
    provider: AiProviderCatalogEntry,
  ): HTMLElement {
    const view = toAiProviderCardView(snapshot, provider);
    const card = document.createElement('article');
    card.className = 'ai-provider-card';

    const header = document.createElement('div');
    header.className = 'ai-provider-card-header';
    const name = document.createElement('h4');
    name.className = 'ai-provider-name';
    name.textContent = view.displayName;
    const status = document.createElement('span');
    status.className = `ai-provider-status ai-provider-status--${view.badgeState}`;
    status.textContent = view.badgeText;
    header.appendChild(name);
    header.appendChild(status);
    card.appendChild(header);

    if (view.statusMessage) {
      const statusMessage = document.createElement('div');
      statusMessage.className = 'ai-provider-status-message';
      statusMessage.textContent = view.statusMessage;
      card.appendChild(statusMessage);
    }

    const links = document.createElement('div');
    links.className = 'ai-provider-links';
    links.appendChild(createExternalLink('Aktuelle API-Preise', provider.helpLinks.pricing));
    links.appendChild(createExternalLink('Ausgabenlimit verwalten', provider.helpLinks.spendingLimits));
    card.appendChild(links);

    let generalAcknowledged = false;
    let providerAcknowledged = false;
    let apiKey = '';
    let busy = false;
    const needsWarningAcknowledgement = requiresWarningAcknowledgement(
      provider,
      view.connection,
    );
    let acknowledgementButton: HTMLElement | undefined;

    for (const warning of providerWarnings(snapshot, provider)) {
      const warningBlock = document.createElement('div');
      warningBlock.className = `ai-provider-warning ai-provider-warning--${warning.kind}`;
      const warningTitle = document.createElement('div');
      warningTitle.className = 'ai-provider-warning-title';
      warningTitle.textContent = warning.title;
      const warningText = document.createElement('div');
      warningText.className = 'ai-provider-warning-text';
      warningText.textContent = warning.text;
      warningBlock.appendChild(warningTitle);
      warningBlock.appendChild(warningText);

      const acknowledgement = createCheckbox(
        `ai-provider-${provider.id}-${warning.kind}`,
        warning.kind === 'general'
          ? 'Ich habe den allgemeinen Kostenhinweis gelesen und bestätige ihn.'
          : 'Ich habe auch den zusätzlichen Claude-Hinweis gelesen und bestätige ihn.',
        (checked) => {
          if (warning.kind === 'general') generalAcknowledged = checked;
          else providerAcknowledged = checked;
          updateSaveState();
        },
      );
      acknowledgement.input.disabled = view.mutationsDisabled;
      warningBlock.appendChild(acknowledgement.row);
      card.appendChild(warningBlock);
    }

    const keyGroup = document.createElement('label');
    keyGroup.className = 'ai-provider-key-group';
    const keyLabel = document.createElement('span');
    keyLabel.textContent = view.connection
      ? 'API-Schlüssel ersetzen'
      : 'API-Schlüssel';
    const keyInput = document.createElement('input');
    keyInput.className = 'ai-provider-key-input';
    keyInput.type = 'password';
    keyInput.autocomplete = 'new-password';
    keyInput.placeholder = 'API-Schlüssel eingeben';
    keyInput.value = '';
    keyInput.disabled = view.mutationsDisabled;
    keyInput.addEventListener('input', () => {
      apiKey = keyInput.value;
      updateSaveState();
    });
    keyGroup.appendChild(keyLabel);
    keyGroup.appendChild(keyInput);
    card.appendChild(keyGroup);

    const actions = document.createElement('div');
    actions.className = 'ai-provider-actions';
    const saveButton = sarahButton({
      label: view.connection ? 'Schlüssel ersetzen' : 'Schlüssel speichern',
      onClick: () => {
        const input = buildSaveApiKeyInput(
          snapshot,
          provider,
          apiKey,
          generalAcknowledged,
          providerAcknowledged,
        );
        if (!input || busy) return;
        busy = true;
        updateSaveState();
        void submitApiKey(api.aiProviders, input, () => {
          apiKey = '';
          keyInput.value = '';
        }).then(applyOutcome).finally(() => {
          busy = false;
          updateSaveState();
        });
      },
    });
    actions.appendChild(saveButton);

    if (needsWarningAcknowledgement) {
      const button = sarahButton({
        label: 'Kostenhinweise erneut bestätigen',
        variant: 'secondary',
        onClick: () => {
          const input = buildAcknowledgeWarningsInput(
            snapshot,
            provider,
            generalAcknowledged,
            providerAcknowledged,
          );
          if (!input || busy) return;
          busy = true;
          updateSaveState();
          void submitWarningAcknowledgement(api.aiProviders, input)
            .then(applyOutcome)
            .finally(() => {
              busy = false;
              updateSaveState();
            });
        },
      });
      acknowledgementButton = button;
      actions.appendChild(button);
    }

    const healthButton = sarahButton({
      label: 'Prüfung noch nicht verfügbar',
      variant: 'secondary',
      disabled: true,
    });
    actions.appendChild(healthButton);
    card.appendChild(actions);

    if (view.connection) {
      card.appendChild(createDeleteControl(
        view.displayName,
        view.connection.connectionId,
        view.mutationsDisabled,
      ));
    }

    updateSaveState();
    return card;

    function updateSaveState(): void {
      const canSave = !busy && buildSaveApiKeyInput(
        snapshot,
        provider,
        apiKey,
        generalAcknowledged,
        providerAcknowledged,
      ) !== null;
      toggleDisabled(saveButton, !canSave);
      if (acknowledgementButton) {
        toggleDisabled(
          acknowledgementButton,
          busy || buildAcknowledgeWarningsInput(
            snapshot,
            provider,
            generalAcknowledged,
            providerAcknowledged,
          ) === null,
        );
      }
      keyInput.disabled = busy || view.mutationsDisabled;
    }
  }

  function createExternalLink(label: string, url: string): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ai-provider-link';
    button.textContent = label;
    button.addEventListener('click', () => {
      void api.openExternalUrl(url).catch(() => {
        showFeedback('Der externe Link konnte nicht geöffnet werden.');
      });
    });
    return button;
  }

  function createDeleteControl(
    providerName: string,
    connectionId: string,
    disabled: boolean,
  ): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.className = 'ai-provider-delete';
    const revealButton = sarahButton({
      label: 'Verbindung löschen',
      variant: 'ghost',
      disabled,
      onClick: () => {
        confirmation.hidden = false;
        toggleDisabled(revealButton, true);
      },
    });
    wrapper.appendChild(revealButton);

    const confirmation = document.createElement('div');
    confirmation.className = 'ai-provider-delete-confirmation';
    confirmation.hidden = true;
    const text = document.createElement('div');
    text.textContent = `${providerName} wirklich löschen? Zugehörige Rollenbindungen werden ebenfalls entfernt.`;
    confirmation.appendChild(text);
    const controls = document.createElement('div');
    controls.className = 'ai-provider-delete-actions';
    let deleting = false;
    const confirmButton = sarahButton({
      label: 'Löschen bestätigen',
      variant: 'secondary',
      onClick: () => {
        if (deleting) return;
        deleting = true;
        toggleDisabled(confirmButton, true);
        toggleDisabled(cancelButton, true);
        void deleteAiConnection(api.aiProviders, connectionId).then(applyOutcome).finally(() => {
          deleting = false;
          toggleDisabled(confirmButton, false);
          toggleDisabled(cancelButton, false);
        });
      },
    });
    const cancelButton = sarahButton({
      label: 'Abbrechen',
      variant: 'ghost',
      onClick: () => {
        confirmation.hidden = true;
        toggleDisabled(revealButton, false);
      },
    });
    controls.appendChild(confirmButton);
    controls.appendChild(cancelButton);
    confirmation.appendChild(controls);
    wrapper.appendChild(confirmation);
    return wrapper;
  }

  function createBindingsEditor(snapshot: AiProviderHubSnapshot): HTMLElement {
    const editor = document.createElement('section');
    editor.className = 'ai-role-bindings';
    const heading = document.createElement('h4');
    heading.className = 'ai-role-bindings-title';
    heading.textContent = 'Rollenbindungen';
    editor.appendChild(heading);

    const inactiveHint = document.createElement('div');
    inactiveHint.className = 'ai-role-bindings-inactive';
    inactiveHint.textContent = 'Noch nicht aktiv: Die Anbieteradapter folgen in einem späteren Schritt.';
    editor.appendChild(inactiveHint);

    const rows = document.createElement('div');
    rows.className = 'ai-role-binding-rows';
    editor.appendChild(rows);
    const actions = document.createElement('div');
    actions.className = 'ai-role-binding-actions';
    editor.appendChild(actions);

    let draftBindings: AiRoleBinding[] = snapshot.bindings.map((binding) => ({ ...binding }));
    let saving = false;

    function renderRows(): void {
      rows.replaceChildren();
      actions.replaceChildren();
      for (const role of ROLE_ORDER) rows.appendChild(createRoleRow(role));
      const saveButton = sarahButton({
        label: 'Rollenbindungen speichern',
        disabled: snapshot.storage.state === 'degraded' || saving,
        onClick: () => {
          const input = buildReplaceBindingsInput(snapshot, draftBindings);
          if (!input || saving) {
            showFeedback('Die Rollenbindungen sind unvollständig oder nicht kompatibel.');
            return;
          }
          saving = true;
          toggleDisabled(saveButton, true);
          void submitRoleBindings(api.aiProviders, input).then(applyOutcome).finally(() => {
            saving = false;
            toggleDisabled(saveButton, snapshot.storage.state === 'degraded');
          });
        },
      });
      actions.appendChild(saveButton);
    }

    function createRoleRow(role: AiProviderRole): HTMLElement {
      const row = document.createElement('div');
      row.className = 'ai-role-row';
      const roleHeader = document.createElement('div');
      roleHeader.className = 'ai-role-header';
      const roleName = document.createElement('div');
      roleName.className = 'ai-role-name';
      roleName.textContent = AI_ROLE_LABELS[role];
      roleHeader.appendChild(roleName);
      row.appendChild(roleHeader);

      const entries = draftBindings
        .filter((binding) => binding.role === role)
        .sort((left, right) => left.position - right.position);
      const options = compatibleBindingOptions(snapshot, role);
      if (entries.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'settings-hint';
        empty.textContent = options.length === 0
          ? 'Zuerst einen kompatiblen API-Schlüssel speichern.'
          : 'Noch keine Standardverbindung ausgewählt.';
        row.appendChild(empty);
      }
      entries.forEach((binding, index) => row.appendChild(
        createBindingEntry(binding, index, entries, options),
      ));

      const used = new Set(entries.map((binding) => (
        bindingOptionKey(binding.connectionId, binding.operationId)
      )));
      const nextOption = options.find((option) => !used.has(option.key));
      const addButton = sarahButton({
        label: entries.length === 0 ? 'Standard hinzufügen' : 'Fallback hinzufügen',
        variant: 'secondary',
        disabled: !nextOption || snapshot.storage.state === 'degraded',
        onClick: () => {
          if (!nextOption) return;
          draftBindings = [...orderRoleBindings([
            ...draftBindings,
            {
              bindingId: crypto.randomUUID(),
              connectionId: nextOption.connectionId,
              role,
              operationId: nextOption.operationId,
              modelProfile: 'provider_default',
              enabled: true,
              position: entries.length,
              revision: Math.max(1, snapshot.bindingRevision + 1),
            },
          ])];
          renderRows();
        },
      });
      roleHeader.appendChild(addButton);
      return row;
    }

    function createBindingEntry(
      binding: AiRoleBinding,
      index: number,
      roleBindings: readonly AiRoleBinding[],
      allOptions: readonly AiBindingOption[],
    ): HTMLElement {
      const entry = document.createElement('div');
      entry.className = 'ai-role-binding-entry';
      const order = document.createElement('div');
      order.className = 'ai-role-binding-order';
      order.textContent = index === 0 ? 'Standard' : `Fallback ${index}`;
      entry.appendChild(order);

      const usedByOthers = new Set(roleBindings
        .filter((candidate) => candidate.bindingId !== binding.bindingId)
        .map((candidate) => bindingOptionKey(candidate.connectionId, candidate.operationId)));
      const availableOptions = allOptions.filter((option) => !usedByOthers.has(option.key));
      const select = document.createElement('select');
      select.className = 'ai-role-binding-select';
      select.disabled = snapshot.storage.state === 'degraded';
      for (const option of availableOptions) {
        const element = document.createElement('option');
        element.value = option.key;
        element.textContent = option.label;
        select.appendChild(element);
      }
      select.value = bindingOptionKey(binding.connectionId, binding.operationId);
      select.addEventListener('change', () => {
        const selected = availableOptions.find((option) => option.key === select.value);
        if (!selected) return;
        draftBindings = draftBindings.map((candidate) => candidate.bindingId === binding.bindingId
          ? {
              ...candidate,
              connectionId: selected.connectionId,
              operationId: selected.operationId,
              modelProfile: 'provider_default',
            }
          : candidate);
        renderRows();
      });
      entry.appendChild(select);

      const profile = document.createElement('span');
      profile.className = 'ai-role-binding-profile';
      profile.textContent = 'Anbieterstandard';
      profile.title = 'provider_default';
      entry.appendChild(profile);

      const enabled = createCheckbox(
        `ai-binding-enabled-${binding.bindingId}`,
        'Aktiviert',
        (checked) => {
          draftBindings = draftBindings.map((candidate) => candidate.bindingId === binding.bindingId
            ? { ...candidate, enabled: checked }
            : candidate);
        },
      );
      enabled.input.checked = binding.enabled;
      enabled.input.disabled = snapshot.storage.state === 'degraded';
      entry.appendChild(enabled.row);

      const controls = document.createElement('div');
      controls.className = 'ai-role-binding-controls';
      controls.appendChild(sarahButton({
        label: '↑',
        variant: 'ghost',
        disabled: index === 0 || snapshot.storage.state === 'degraded',
        onClick: () => moveBinding(binding.role, index, -1),
      }));
      controls.appendChild(sarahButton({
        label: '↓',
        variant: 'ghost',
        disabled: index === roleBindings.length - 1 || snapshot.storage.state === 'degraded',
        onClick: () => moveBinding(binding.role, index, 1),
      }));
      controls.appendChild(sarahButton({
        label: 'Entfernen',
        variant: 'ghost',
        disabled: snapshot.storage.state === 'degraded',
        onClick: () => {
          draftBindings = [...orderRoleBindings(
            draftBindings.filter((candidate) => candidate.bindingId !== binding.bindingId),
          )];
          renderRows();
        },
      }));
      entry.appendChild(controls);
      return entry;
    }

    function moveBinding(role: AiProviderRole, index: number, offset: -1 | 1): void {
      draftBindings = [...moveRoleBinding(draftBindings, role, index, offset)];
      renderRows();
    }

    renderRows();
    return editor;
  }

  content.textContent = 'KI-Anbieter werden geladen …';
  void api.aiProviders.list().then(render).catch(() => {
    content.textContent = '';
    showFeedback('Die KI-Anbieter konnten nicht geladen werden.');
  });

  return root;
}

function createCheckbox(
  id: string,
  label: string,
  onChange: (checked: boolean) => void,
): { readonly row: HTMLLabelElement; readonly input: HTMLInputElement } {
  const row = document.createElement('label');
  row.className = 'ai-provider-checkbox';
  row.htmlFor = id;
  const input = document.createElement('input');
  input.id = id;
  input.type = 'checkbox';
  input.addEventListener('change', () => onChange(input.checked));
  const text = document.createElement('span');
  text.textContent = label;
  row.appendChild(input);
  row.appendChild(text);
  return { row, input };
}

function toggleDisabled(element: HTMLElement, disabled: boolean): void {
  if (disabled) element.setAttribute('disabled', '');
  else element.removeAttribute('disabled');
}
