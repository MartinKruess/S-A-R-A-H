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
    }).effect).toBe('confirm');
  });

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
