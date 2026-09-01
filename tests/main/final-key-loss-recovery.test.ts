import { describe, expect, it, vi } from 'vitest';
import type { MessageBoxOptions, MessageBoxReturnValue } from 'electron';
import { FINAL_KEY_LOSS_RESET_CONFIRMATION } from '../../src/core/crypto/key-loss-reset.js';
import { handleFinalKeyLossRecovery } from '../../src/main/final-key-loss-recovery.js';

function response(value: number): MessageBoxReturnValue {
  return { response: value, checkboxChecked: false };
}

describe('handleFinalKeyLossRecovery', () => {
  it('uses cancellation as the safe default and leaves storage untouched', async () => {
    const dialogs: MessageBoxOptions[] = [];
    const reset = vi.fn();
    const relaunch = vi.fn();
    const exit = vi.fn();

    const handled = await handleFinalKeyLossRecovery(['sarah.db'], {
      showMessageBox: vi.fn(async (options) => {
        dialogs.push(options);
        return response(0);
      }),
      reset,
      relaunch,
      exit,
    });

    expect(handled).toBe(false);
    expect(reset).not.toHaveBeenCalled();
    expect(relaunch).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    expect(dialogs[0]).toMatchObject({
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      buttons: ['Beenden', 'Unlesbare Daten archivieren und Sarah zurücksetzen'],
    });
    expect(dialogs[0].detail).toContain('bereits nicht mehr lesbar');
    expect(dialogs[0].detail).toContain('nicht automatisch wiederherstellbar');
    expect(dialogs[0].detail).toContain('sarah.db');
  });

  it('resets only after confirmation and relaunches after the success notice', async () => {
    const order: string[] = [];
    const reset = vi.fn((_confirmation: typeof FINAL_KEY_LOSS_RESET_CONFIRMATION) => {
      order.push('reset');
      return {
        archivePath: 'C:\\Sarah\\key-loss-recovery\\archive',
        archivedFiles: ['sarah.key', 'sarah.db'],
      };
    });
    const showMessageBox = vi.fn(async (_options: MessageBoxOptions) => {
      order.push('dialog');
      return response(showMessageBox.mock.calls.length === 1 ? 1 : 0);
    });

    const handled = await handleFinalKeyLossRecovery(['sarah.key', 'sarah.db'], {
      showMessageBox,
      reset,
      relaunch: () => { order.push('relaunch'); },
      exit: () => { order.push('exit'); },
    });

    expect(handled).toBe(true);
    expect(reset).toHaveBeenCalledTimes(1);
    expect(reset.mock.calls[0][0]).toBe(FINAL_KEY_LOSS_RESET_CONFIRMATION);
    expect(showMessageBox).toHaveBeenCalledTimes(2);
    expect(String(showMessageBox.mock.calls[1][0].detail)).toContain('key-loss-recovery');
    expect(order).toEqual(['dialog', 'reset', 'dialog', 'relaunch', 'exit']);
  });

  it('does not announce success or relaunch when the reset fails', async () => {
    const failure = new Error('archive failed');
    const showMessageBox = vi.fn(async () => response(1));
    const relaunch = vi.fn();
    const exit = vi.fn();

    await expect(handleFinalKeyLossRecovery(['sarah.key'], {
      showMessageBox,
      reset: () => { throw failure; },
      relaunch,
      exit,
    })).rejects.toBe(failure);

    expect(showMessageBox).toHaveBeenCalledTimes(1);
    expect(relaunch).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });
});
