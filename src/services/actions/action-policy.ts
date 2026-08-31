import type { Trust } from '../../core/config-schema.js';
import type { ConfirmationLevel } from '../../core/action-confirmation.js';
import type { ActionName } from './action-schemas.js';

export type ActionPolicyEffect = 'allow' | 'confirm' | 'deny' | 'prepare_only';
export type ActionRisk = 'read' | 'reversible' | 'sensitive' | 'critical';
export type FilePermission = 'none' | 'read' | 'write';

export interface ActionPermissionMetadata {
  permission: string;
  risk: ActionRisk;
  filePermission: FilePermission;
  externalCommitment: boolean;
  mayCostMoney: boolean;
  dataDisclosure: 'none' | 'query' | 'personal';
  persistentGrant?: 'web-access';
}

export interface ActionPolicyContext {
  confirmationLevel: ConfirmationLevel;
  fileAccess: Trust['fileAccess'];
  webAccessAllowed?: boolean;
  /** Set by a future file boundary after resolving an allowed-folder grant. */
  fileTargetAllowed?: boolean;
  /** Canonical action parameter when the risk depends on the selected scope. */
  param?: string;
}

export interface ActionPolicyDecision {
  effect: ActionPolicyEffect;
  metadata: ActionPermissionMetadata;
  reason: string;
}

export const ACTION_PERMISSION_METADATA: Record<ActionName, ActionPermissionMetadata> = {
  open_program: { permission: 'application.launch', risk: 'reversible', filePermission: 'none', externalCommitment: false, mayCostMoney: false, dataDisclosure: 'none' },
  web_search: { permission: 'network.search', risk: 'read', filePermission: 'none', externalCommitment: false, mayCostMoney: false, dataDisclosure: 'query', persistentGrant: 'web-access' },
  show_browser: { permission: 'network.open_result', risk: 'read', filePermission: 'none', externalCommitment: false, mayCostMoney: false, dataDisclosure: 'none', persistentGrant: 'web-access' },
  set_volume: { permission: 'system.volume', risk: 'reversible', filePermission: 'none', externalCommitment: false, mayCostMoney: false, dataDisclosure: 'none' },
  spotify_volume: { permission: 'spotify.volume', risk: 'reversible', filePermission: 'none', externalCommitment: false, mayCostMoney: false, dataDisclosure: 'none' },
  spotify_volume_adjust: { permission: 'spotify.volume', risk: 'reversible', filePermission: 'none', externalCommitment: false, mayCostMoney: false, dataDisclosure: 'none' },
  set_timer: { permission: 'system.timer', risk: 'reversible', filePermission: 'none', externalCommitment: false, mayCostMoney: false, dataDisclosure: 'none' },
  cancel_timer: { permission: 'system.timer', risk: 'reversible', filePermission: 'none', externalCommitment: false, mayCostMoney: false, dataDisclosure: 'none' },
  set_reminder: { permission: 'system.reminder', risk: 'reversible', filePermission: 'none', externalCommitment: false, mayCostMoney: false, dataDisclosure: 'none' },
  list_reminders: { permission: 'system.reminder', risk: 'read', filePermission: 'none', externalCommitment: false, mayCostMoney: false, dataDisclosure: 'none' },
  cancel_reminder: { permission: 'system.reminder', risk: 'reversible', filePermission: 'none', externalCommitment: false, mayCostMoney: false, dataDisclosure: 'none' },
  lock_screen: { permission: 'system.lock', risk: 'sensitive', filePermission: 'none', externalCommitment: false, mayCostMoney: false, dataDisclosure: 'none' },
  media_play: { permission: 'media.transport', risk: 'reversible', filePermission: 'none', externalCommitment: false, mayCostMoney: false, dataDisclosure: 'none' },
  media_pause: { permission: 'media.transport', risk: 'reversible', filePermission: 'none', externalCommitment: false, mayCostMoney: false, dataDisclosure: 'none' },
  media_toggle: { permission: 'media.transport', risk: 'reversible', filePermission: 'none', externalCommitment: false, mayCostMoney: false, dataDisclosure: 'none' },
  media_next: { permission: 'media.transport', risk: 'reversible', filePermission: 'none', externalCommitment: false, mayCostMoney: false, dataDisclosure: 'none' },
  media_previous: { permission: 'media.transport', risk: 'reversible', filePermission: 'none', externalCommitment: false, mayCostMoney: false, dataDisclosure: 'none' },
};

/**
 * Evaluates action risk, confirmation preference and the file-access boundary.
 * This is the single policy decision consumed by productive ActionService calls.
 *
 * @category Authorization Business Logic
 */
export function evaluatePermissionMetadata(
  metadata: ActionPermissionMetadata,
  context: ActionPolicyContext,
): ActionPolicyDecision {
  if (metadata.persistentGrant === 'web-access') {
    return context.webAccessAllowed === true
      ? { effect: 'allow', metadata, reason: 'persistent_web_access_grant' }
      : { effect: 'deny', metadata, reason: 'web_access_disabled' };
  }
  if (metadata.filePermission !== 'none') {
    if (context.fileAccess === 'none') {
      return { effect: 'deny', metadata, reason: 'file_access_disabled' };
    }
    if (context.fileAccess === 'specific-folders' && context.fileTargetAllowed !== true) {
      return { effect: 'deny', metadata, reason: 'file_target_not_allowed' };
    }
  }
  if (metadata.mayCostMoney || metadata.externalCommitment) {
    return { effect: 'prepare_only', metadata, reason: 'binding_external_action' };
  }
  const mustConfirm = metadata.dataDisclosure !== 'none'
    || metadata.risk === 'critical'
    || (context.confirmationLevel === 'standard' && metadata.risk === 'sensitive')
    || context.confirmationLevel === 'maximal';
  return mustConfirm
    ? {
        effect: 'confirm',
        metadata,
        reason: metadata.dataDisclosure !== 'none'
          ? 'data_disclosure_confirmation_required'
          : 'confirmation_required',
      }
    : { effect: 'allow', metadata, reason: 'policy_allows' };
}

export function evaluateActionPolicy(
  action: ActionName,
  context: ActionPolicyContext,
): ActionPolicyDecision {
  const metadata = action === 'cancel_reminder'
    && context.param?.trim().toLocaleLowerCase('de-DE') === 'all'
    ? { ...ACTION_PERMISSION_METADATA[action], risk: 'critical' as const }
    : ACTION_PERMISSION_METADATA[action];
  return evaluatePermissionMetadata(metadata, context);
}
