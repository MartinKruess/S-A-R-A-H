import type { SarahApi } from '../../../../core/sarah-api.js';
import type { SpecialistTaskSnapshot } from '../../../../core/specialist-task.js';
import { getSarah } from '../../../shared/window-global.js';

const STATUS_LABELS = {
  queued: 'Wartet', starting: 'Startet', running: 'Läuft', waiting_for_user: 'Rückfrage',
  completed: 'Abgeschlossen', failed: 'Fehlgeschlagen', cancel_requested: 'Abbruch angefordert',
  canceled: 'Abgebrochen', incomplete: 'Unvollständig',
} as const;

/** Validates external result links before handing them to the Main-owned opener. */
export function isSafeSpecialistCitation(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && !parsed.username && !parsed.password;
  } catch { return false; }
}

/** Renders ephemeral results and sequence-bound controls without interpreting provider HTML. */
export function createSpecialistTaskSection(api: SarahApi = getSarah()): HTMLElement {
  const root = document.createElement('section');
  root.className = 'specialist-task-section';
  const heading = document.createElement('h4');
  heading.textContent = 'Spezialisten-Aufgaben';
  const feedback = document.createElement('div');
  feedback.setAttribute('role', 'status');
  const tasks = document.createElement('div');
  const refresh = document.createElement('button');
  refresh.type = 'button';
  refresh.textContent = 'Aufgaben aktualisieren';
  refresh.addEventListener('click', () => { void load(); });
  root.append(heading, refresh, feedback, tasks);

  async function load(): Promise<void> {
    refresh.disabled = true;
    try {
      const snapshots = await api.specialists.list();
      tasks.replaceChildren(...snapshots.map(renderTask));
      if (!snapshots.length) tasks.textContent = 'Keine Aufgaben vorhanden.';
    } catch { feedback.textContent = 'Aufgaben konnten nicht geladen werden.'; }
    finally { refresh.disabled = false; }
  }

  function renderTask(task: SpecialistTaskSnapshot): HTMLElement {
    const card = document.createElement('article');
    const title = document.createElement('h5');
    title.textContent = `${task.role === 'coding' ? 'Programmierung' : 'Recherche'} – ${STATUS_LABELS[task.status]}`;
    const summary = document.createElement('p');
    summary.textContent = task.terminal?.summary ?? task.progressMessage ?? '';
    if (task.status === 'incomplete' || task.status === 'cancel_requested') {
      summary.textContent = 'Der vollständige Abschluss ist nicht bestätigt. Ein Abbruch beim Anbieter und das Ende möglicher Kosten sind nicht garantiert. Prüfe gegebenenfalls dein Anbieterkonto.';
    } else if (task.status === 'failed' && !summary.textContent) {
      summary.textContent = 'Der Anbieterauftrag ist fehlgeschlagen. Verbrauch kann trotzdem entstanden sein.';
    }
    card.append(title, summary);
    if (task.result) {
      const result = document.createElement('pre');
      result.style.whiteSpace = 'pre-wrap';
      result.textContent = task.result.text;
      card.appendChild(result);
      for (const citation of task.result.citations) {
        if (!isSafeSpecialistCitation(citation.url)) continue;
        const link = document.createElement('button');
        link.type = 'button';
        link.textContent = citation.title;
        link.addEventListener('click', () => {
          void api.openExternalUrl(citation.url).catch(() => { feedback.textContent = 'Quelle konnte nicht geöffnet werden.'; });
        });
        card.appendChild(link);
      }
    }
    function action(label: string, run: () => ReturnType<SarahApi['specialists']['cancel']>): void {
      const button = document.createElement('button');
      button.type = 'button'; button.textContent = label;
      button.addEventListener('click', () => {
        const controls = card.querySelectorAll('button, input');
        controls.forEach((control) => control.setAttribute('disabled', ''));
        void run().then(async (result) => {
          feedback.textContent = result.ok ? 'Aufgabe aktualisiert.' : result.message;
          await load();
        }).catch(() => { feedback.textContent = 'Aktion konnte nicht bestätigt werden. Bitte aktualisiere die Aufgaben.'; });
      });
      card.appendChild(button);
    }
    if (task.inputRequest && task.status === 'waiting_for_user') {
      const prompt = document.createElement('p'); prompt.textContent = task.inputRequest.prompt;
      const answer = document.createElement('input'); answer.type = 'text'; answer.maxLength = 4000;
      answer.setAttribute('aria-label', 'Antwort auf die Rückfrage');
      card.append(prompt, answer);
      const requestId = task.inputRequest.requestId;
      action('Antwort senden', () => api.specialists.provideInput({ taskId: task.taskId, requestId,
        expectedSequence: task.sequence, input: answer.value.trim() }));
      action('Fortsetzen (keine zusätzliche Freigabe)', () => api.specialists.resume({ taskId: task.taskId,
        requestId, expectedSequence: task.sequence }));
    }
    if (!['completed', 'failed', 'canceled', 'incomplete'].includes(task.status)) {
      action('Aufgabe abbrechen', () => api.specialists.cancel({ taskId: task.taskId }));
    }
    return card;
  }
  void load();
  return root;
}
