let recoveryEventPending = false;

export function markPasswordRecoveryEvent(): void {
  recoveryEventPending = true;
}

export function consumePasswordRecoveryEvent(): boolean {
  const pending = recoveryEventPending;
  recoveryEventPending = false;
  return pending;
}
