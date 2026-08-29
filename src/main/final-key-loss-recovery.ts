import type { MessageBoxOptions, MessageBoxReturnValue } from 'electron';
import {
  FINAL_KEY_LOSS_RESET_CONFIRMATION,
  type KeyLossResetResult,
} from '../core/crypto/key-loss-reset.js';

export interface FinalKeyLossRecoveryDependencies {
  showMessageBox: (options: MessageBoxOptions) => Promise<MessageBoxReturnValue>;
  reset: (confirmation: typeof FINAL_KEY_LOSS_RESET_CONFIRMATION) => KeyLossResetResult;
  relaunch: () => void;
  exit: (code: number) => void;
}

/**
 * @param affectedFiles - Namen der verschlüsselten Dateien, deren Schlüssel nicht mehr lesbar ist.
 * @param dependencies - Native Dialog-, Reset- und Neustartfunktionen.
 *
 * - Informiert über den bereits eingetretenen Schlüsselverlust.
 * - Führt den archivierenden Reset nur nach einer ausdrücklich destruktiven Auswahl aus.
 * - Startet Sarah erst nach einem vollständig erfolgreichen Reset neu.
 *
 * @returns `true`, wenn ein Reset abgeschlossen wurde und der Neustart beginnt.
 *
 * @category Recovery Event Handler
 */
export async function handleFinalKeyLossRecovery(
  affectedFiles: readonly string[],
  dependencies: FinalKeyLossRecoveryDependencies,
): Promise<boolean> {
  const affected = affectedFiles.length > 0
    ? `\n\nBetroffene Dateien:\n${affectedFiles.map((file) => `• ${file}`).join('\n')}`
    : '';
  const choice = await dependencies.showMessageBox({
    type: 'warning',
    title: 'Verschlüsselte Daten nicht mehr lesbar',
    message: 'Sarah kann den bisherigen Verschlüsselungsschlüssel nicht mehr öffnen.',
    detail: 'Die vorhandenen Daten sind bereits nicht mehr lesbar. Sarah überschreibt sie nicht. '
      + 'Beim Zurücksetzen werden die unlesbaren Originaldateien separat archiviert; dieses Archiv '
      + 'ist derzeit nicht automatisch wiederherstellbar. Danach startet Sarah mit leerem Gedächtnis, '
      + `leeren Einstellungen und ohne gespeicherte Verbindungen.${affected}`,
    buttons: ['Beenden', 'Unlesbare Daten archivieren und Sarah zurücksetzen'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  if (choice.response !== 1) return false;

  const result = dependencies.reset(FINAL_KEY_LOSS_RESET_CONFIRMATION);
  await dependencies.showMessageBox(successDialog(result));
  dependencies.relaunch();
  dependencies.exit(0);
  return true;
}

function successDialog(result: KeyLossResetResult): MessageBoxOptions {
  return {
    type: 'info',
    title: 'Sarah wird neu eingerichtet',
    message: 'Die unlesbaren Daten wurden archiviert.',
    detail: `Archiv: ${result.archivePath}\n\nSarah startet jetzt mit einem neuen Schlüssel und leerem Speicher.`,
    buttons: ['Neu starten'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
}
