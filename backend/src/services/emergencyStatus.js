const { displayName } = require('../utils/displayName');

/**
 * The status of an emergency alert at the CaribWayz Emergency Desk
 * (emergency_alerts.desk_status, migration 033).
 *
 * The words and their meanings are the Emergency Desk Disclaimer's, section 5:
 *
 *   pending       submitted or recorded, awaiting processing or acknowledgment
 *   acknowledged  a desk operator recorded an acknowledgment; it does not mean
 *                 an emergency responder has been dispatched (5.4)
 *   addressed     marked as addressed within the Platform; it does not
 *                 establish that help was provided or that the emergency is
 *                 over (5.5)
 *   cancelled     cancelled by the person who raised it (5.6)
 *
 * resolved is not one of them. It exists only on alerts closed by someone
 * other than the sender through the API released before migration 033
 * (before the migration, or by that API during a deploy or after a rollback;
 * the trigger in migration 033 records it), because "resolved" is what that
 * API recorded; this API never sets it. Each status is kept
 * apart from the others (Dr. B, 2026-11-17: they "must never be treated as
 * interchangeable"): one is never shown, stored or announced as another.
 *
 * emergency_alerts.status stays the open/closed flag every existing reader
 * filters on, and the value the app 1.0.11 reads: 'active' while the desk
 * status is pending or acknowledged, 'resolved' once it is anything else. A
 * CHECK constraint keeps the two in step.
 */
const DESK_STATUS = Object.freeze({
  PENDING: 'pending',
  ACKNOWLEDGED: 'acknowledged',
  ADDRESSED: 'addressed',
  CANCELLED: 'cancelled',
  RESOLVED: 'resolved',
});

const DESK_STATUSES = Object.freeze(Object.values(DESK_STATUS));

/** The statuses in which an alert is still open at the desk. */
const OPEN_DESK_STATUSES = Object.freeze([DESK_STATUS.PENDING, DESK_STATUS.ACKNOWLEDGED]);

/** The word shown to people for each status, exactly as the disclaimer has it. */
const DESK_STATUS_LABELS = Object.freeze({
  pending: 'Pending',
  acknowledged: 'Acknowledged',
  addressed: 'Addressed',
  cancelled: 'Cancelled',
  resolved: 'Resolved',
});

const sameUser = (a, b) => a != null && b != null && String(a).toLowerCase() === String(b).toLowerCase();

/**
 * The desk status of [row]. A row read before migration 033 (or built by a
 * test without the column) is given the status migration 033 would give it:
 * an open alert is acknowledged when acknowledged_at is set, otherwise
 * pending; a closed alert the sender closed is cancelled; any other closed
 * alert keeps the resolved it was recorded with.
 */
const deskStatusOf = (row) => {
  if (row && DESK_STATUSES.includes(row.desk_status)) return row.desk_status;
  if (!row || row.status === 'active' || row.status == null) {
    return row && row.acknowledged_at ? DESK_STATUS.ACKNOWLEDGED : DESK_STATUS.PENDING;
  }
  return sameUser(row.resolved_by, row.user_id) ? DESK_STATUS.CANCELLED : DESK_STATUS.RESOLVED;
};

const isOpenDeskStatus = (deskStatus) => OPEN_DESK_STATUSES.includes(deskStatus);

/** emergency_alerts.status for [deskStatus]: the legacy open/closed value. */
const legacyStatusFor = (deskStatus) => (isOpenDeskStatus(deskStatus) ? 'active' : 'resolved');

/** When [row] was closed, whichever way, or null while it is open. */
const closedAtOf = (row) => {
  if (isOpenDeskStatus(deskStatusOf(row))) return null;
  return row.addressed_at || row.cancelled_at || row.resolved_at || null;
};

/** "This emergency is already closed (status: Addressed)". */
const alreadyClosedMessage = (deskStatus) =>
  `This emergency is already closed (status: ${DESK_STATUS_LABELS[deskStatus] || deskStatus})`;

/** The actions that change a desk status, and the statuses each one starts from. */
const ACTIONS = Object.freeze({
  acknowledge: { from: [DESK_STATUS.PENDING], to: DESK_STATUS.ACKNOWLEDGED },
  release: { from: [DESK_STATUS.ACKNOWLEDGED], to: DESK_STATUS.PENDING },
  address: { from: [DESK_STATUS.PENDING, DESK_STATUS.ACKNOWLEDGED], to: DESK_STATUS.ADDRESSED },
  cancel: { from: [DESK_STATUS.PENDING, DESK_STATUS.ACKNOWLEDGED], to: DESK_STATUS.CANCELLED },
});

/**
 * Whether [actor] may take [action] on [row] now, and if not, why.
 *
 * actor: { id, isAdmin, isResponder }. Whether the actor raised the alert is
 * read from row.user_id.
 *
 * Returns one of:
 *   { outcome: 'apply', to }              make the change
 *   { outcome: 'unchanged', message }     already so; answer 200, change nothing
 *   { outcome: 'forbidden', message }     403
 *   { outcome: 'conflict', message }      409
 *
 * Who may do what:
 *   acknowledge  a responder or admin, on a pending alert
 *   release      the operator who acknowledged it, or an admin
 *   address      a responder or admin; once acknowledged, only the operator
 *                who acknowledged it, or an admin
 *   cancel       only the person who raised it
 * Nothing moves an alert out of addressed, cancelled or resolved.
 */
const evaluateTransition = (action, row, actor) => {
  const spec = ACTIONS[action];
  if (!spec) throw new Error(`Unknown desk action: ${action}`);
  const current = deskStatusOf(row);
  const isOwner = sameUser(row.user_id, actor.id);
  const holdsIt = current === DESK_STATUS.ACKNOWLEDGED && sameUser(row.acknowledged_by, actor.id);

  if (action === 'cancel') {
    if (!isOwner) return { outcome: 'forbidden', message: 'Only the person who raised this alert can cancel it' };
    if (current === DESK_STATUS.CANCELLED) return { outcome: 'unchanged', message: 'This emergency alert is already cancelled' };
    if (!spec.from.includes(current)) return { outcome: 'conflict', message: alreadyClosedMessage(current) };
    return { outcome: 'apply', to: spec.to };
  }

  if (!actor.isResponder && !actor.isAdmin) {
    return { outcome: 'forbidden', message: 'Responder access required' };
  }

  if (action === 'acknowledge') {
    if (current === DESK_STATUS.PENDING) return { outcome: 'apply', to: spec.to };
    if (holdsIt) return { outcome: 'unchanged', message: 'You already have this emergency' };
    if (current === DESK_STATUS.ACKNOWLEDGED) {
      const name = displayName(row.acknowledged_by_name, row.acknowledged_by ? 'An operator' : 'A former operator');
      return { outcome: 'conflict', message: `${name} has already taken this emergency` };
    }
    return { outcome: 'conflict', message: alreadyClosedMessage(current) };
  }

  if (action === 'release') {
    if (current === DESK_STATUS.PENDING) return { outcome: 'unchanged', message: 'Emergency is already in the queue' };
    if (current !== DESK_STATUS.ACKNOWLEDGED) return { outcome: 'conflict', message: alreadyClosedMessage(current) };
    if (!holdsIt && !actor.isAdmin) {
      return { outcome: 'forbidden', message: 'Only the operator who took this emergency, or an administrator, can return it' };
    }
    return { outcome: 'apply', to: spec.to };
  }

  // address
  if (current === DESK_STATUS.ADDRESSED) return { outcome: 'unchanged', message: 'This emergency is already marked Addressed' };
  if (!spec.from.includes(current)) return { outcome: 'conflict', message: alreadyClosedMessage(current) };
  if (current === DESK_STATUS.ACKNOWLEDGED && !holdsIt && !actor.isAdmin) {
    return {
      outcome: 'forbidden',
      message: 'Only the operator who acknowledged this emergency, or an administrator, can mark it Addressed',
    };
  }
  return { outcome: 'apply', to: spec.to };
};

module.exports = {
  DESK_STATUS,
  DESK_STATUSES,
  OPEN_DESK_STATUSES,
  DESK_STATUS_LABELS,
  ACTIONS,
  deskStatusOf,
  isOpenDeskStatus,
  legacyStatusFor,
  closedAtOf,
  alreadyClosedMessage,
  evaluateTransition,
};
