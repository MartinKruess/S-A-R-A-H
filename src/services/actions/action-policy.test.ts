import { describe, expect, it } from 'vitest';
import {
  evaluateActionPolicy,
  evaluatePermissionMetadata,
  type ActionPermissionMetadata,
} from './action-policy.js';

describe('action policy', () => {
  it('makes minimal, standard and maximal materially distinct', () => {
    expect(evaluateActionPolicy('lock_screen', {
      confirmationLevel: 'minimal', fileAccess: 'none',
    }).effect).toBe('allow');
    expect(evaluateActionPolicy('lock_screen', {
      confirmationLevel: 'standard', fileAccess: 'none',
    }).effect).toBe('confirm');
    expect(evaluateActionPolicy('media_next', {
      confirmationLevel: 'standard', fileAccess: 'none',
    }).effect).toBe('allow');
    expect(evaluateActionPolicy('media_next', {
      confirmationLevel: 'maximal', fileAccess: 'none',
    }).effect).toBe('confirm');
    expect(evaluateActionPolicy('web_search', {
      confirmationLevel: 'maximal', fileAccess: 'none',
    }).effect).toBe('allow');
  });

  it.each(['set_timer', 'cancel_timer'] as const)(
    'treats %s as a reversible timer action without standard confirmation',
    (action) => {
      expect(evaluateActionPolicy(action, {
        confirmationLevel: 'standard', fileAccess: 'none',
      })).toMatchObject({
        effect: 'allow',
        metadata: { permission: 'system.timer', risk: 'reversible' },
      });
    },
  );

  it.each(['set_reminder', 'cancel_reminder'] as const)(
    'treats %s as a reversible local reminder action without standard confirmation',
    (action) => {
      expect(evaluateActionPolicy(action, {
        confirmationLevel: 'standard', fileAccess: 'none',
      })).toMatchObject({
        effect: 'allow',
        metadata: { permission: 'system.reminder', risk: 'reversible' },
      });
    },
  );

  it('treats reminder listing as read-only', () => {
    expect(evaluateActionPolicy('list_reminders', {
      confirmationLevel: 'standard', fileAccess: 'none',
    })).toMatchObject({
      effect: 'allow',
      metadata: { permission: 'system.reminder', risk: 'read' },
    });
  });

  it.each(['minimal', 'standard', 'maximal'] as const)(
    'uses the persistent browser grant instead of per-search confirmation at %s level',
    (confirmationLevel) => {
      expect(evaluateActionPolicy('web_search', {
        confirmationLevel,
        fileAccess: 'none',
        webAccessAllowed: true,
      })).toMatchObject({
        effect: 'allow',
        reason: 'persistent_web_access_grant',
      });
    },
  );

  it.each(['web_search', 'show_browser'] as const)(
    'denies %s when browser access is disabled',
    (action) => {
      expect(evaluateActionPolicy(action, {
        confirmationLevel: 'minimal',
        fileAccess: 'none',
        webAccessAllowed: false,
      })).toMatchObject({
        effect: 'deny',
        reason: 'web_access_disabled',
      });
    },
  );

  it('enforces the file-access boundary before a file action can execute', () => {
    const fileRead: ActionPermissionMetadata = {
      permission: 'file.read',
      risk: 'read',
      filePermission: 'read',
      externalCommitment: false,
      mayCostMoney: false,
      dataDisclosure: 'none',
    };
    expect(evaluatePermissionMetadata(fileRead, {
      confirmationLevel: 'minimal', fileAccess: 'none',
    }).effect).toBe('deny');
    expect(evaluatePermissionMetadata(fileRead, {
      confirmationLevel: 'minimal', fileAccess: 'specific-folders', fileTargetAllowed: false,
    }).effect).toBe('deny');
    expect(evaluatePermissionMetadata(fileRead, {
      confirmationLevel: 'minimal', fileAccess: 'specific-folders', fileTargetAllowed: true,
    }).effect).toBe('allow');
  });

  it('limits binding or potentially costly actions to preparation', () => {
    const purchase: ActionPermissionMetadata = {
      permission: 'purchase.create',
      risk: 'critical',
      filePermission: 'none',
      externalCommitment: true,
      mayCostMoney: true,
      dataDisclosure: 'personal',
    };
    expect(evaluatePermissionMetadata(purchase, {
      confirmationLevel: 'minimal', fileAccess: 'none',
    }).effect).toBe('prepare_only');
  });
});
