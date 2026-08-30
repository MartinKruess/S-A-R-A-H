export type ReminderState = 'pending' | 'firing' | 'delivered' | 'cancelled';
export type ReminderSourceKind = 'local';

export interface ReminderRecord {
  id: number;
  dueLocal: string;
  text: string;
  state: ReminderState;
  sourceKind: ReminderSourceKind;
  externalId?: string;
  createdAt: string;
  firingAt: string | null;
  deliveredAt: string | null;
  cancelledAt: string | null;
}

export interface CreateReminderInput {
  dueLocal: string;
  text: string;
  sourceKind?: ReminderSourceKind;
  externalId?: string | null;
  createdAt?: string;
}

export interface ReminderAgendaItem {
  kind: 'reminder';
  id: number;
  dueLocal: string;
  text: string;
}

export interface ReminderStateTransition {
  id: number;
  expected: ReminderState;
  next: ReminderState;
  at: string;
}
