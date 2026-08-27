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
}

export interface ActionPolicyContext {
  confirmationLevel: ConfirmationLevel;
  fileAccess: Trust['fileAccess'];
  /** Set by a future file boundary after resolving an allowed-folder grant. */
  fileTargetAllowed?: boolean;
}

export interface ActionPolicyDecision {
  effect: ActionPolicyEffect;
  metadata: ActionPermissionMetadata;
  reason: string;
}

export const ACTION_PERMISSION_METADATA: Record<ActionName, ActionPermissionMetadata> = {
  open_program: { permission: 'application.launch', risk: 'reversible', filePermission: 'none', externalCommitment: false, mayCostMoney: false, dataDisclosure: 'none' },
  web_search: { permission: 'network.search', risk: 'read', filePermission: 'none', externalCommitment: false, mayCostMoney: false, dataDisclosure: 'query' },
  show_browser: { permission: 'network.open_result', risk: 'read', filePermission: 'none', externalCommitment: false, mayCostMoney: false, dataDisclosure: 'none' },
  set_volume: { permission: 'system.volume', risk: 'reversible', filePermission: 'none', externalCommitment: false, mayCostMoney: false, dataDisclosure: 'none' },
  spotify_volume: { permission: 'spotify.volume', risk: 'reversible', filePermission: 'none', externalCommitment: false, mayCostMoney: false, dataDisclosure: 'none' },
  spotify_volume_adjust: { permission: 'spotify.volume', risk: 'reversible', filePermission: 'none', externalCommitment: false, mayCostMoney: false, dataDisclosure: 'none' },
  set_timer: { permission: 'system.timer', risk: 'reversible', filePermission: 'none', externalCommitment: false, mayCostMoney: false, dataDisclosure: 'none' },
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
  const mustConfirm = metadata.risk === 'critical'
    || (context.confirmationLevel === 'standard' && metadata.risk === 'sensitive')
    || context.confirmationLevel === 'maximal';
  return mustConfirm
    ? { effect: 'confirm', metadata, reason: 'confirmation_required' }
    : { effect: 'allow', metadata, reason: 'policy_allows' };
}

export function evaluateActionPolicy(
  action: ActionName,
  context: ActionPolicyContext,
): ActionPolicyDecision {
  return evaluatePermissionMetadata(ACTION_PERMISSION_METADATA[action], context);
}
