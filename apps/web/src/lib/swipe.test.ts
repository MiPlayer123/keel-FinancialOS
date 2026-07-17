import { describe, expect, it } from 'vitest';

import { resolveSwipeDecision } from './swipe';

describe('resolveSwipeDecision', () => {
  it('returns null for a negligible drag (no offset, no velocity)', () => {
    expect(resolveSwipeDecision(0, 0)).toBeNull();
  });

  it('returns null below the flick-distance floor even with huge velocity (jitter guard)', () => {
    expect(resolveSwipeDecision(10, 5000)).toBeNull();
    expect(resolveSwipeDecision(-10, -5000)).toBeNull();
  });

  it('returns null for a slow drag that never reaches the distance threshold', () => {
    expect(resolveSwipeDecision(50, 10)).toBeNull();
    expect(resolveSwipeDecision(-50, -10)).toBeNull();
  });

  it('resolves accept for a full slow rightward drag past the distance threshold', () => {
    expect(resolveSwipeDecision(96, 0)).toBe('accept');
    expect(resolveSwipeDecision(200, 5)).toBe('accept');
  });

  it('resolves dismiss for a full slow leftward drag past the distance threshold', () => {
    expect(resolveSwipeDecision(-96, 0)).toBe('dismiss');
    expect(resolveSwipeDecision(-200, -5)).toBe('dismiss');
  });

  it('resolves accept for a short-but-fast rightward flick', () => {
    expect(resolveSwipeDecision(30, 800)).toBe('accept');
  });

  it('resolves dismiss for a short-but-fast leftward flick', () => {
    expect(resolveSwipeDecision(-30, -800)).toBe('dismiss');
  });

  it('requires the flick floor even when velocity is high — 23px never resolves', () => {
    expect(resolveSwipeDecision(23, 10000)).toBeNull();
  });

  it('resolves right at the flick-distance floor when velocity also clears its bar', () => {
    expect(resolveSwipeDecision(24, 500)).toBe('accept');
    expect(resolveSwipeDecision(-24, -500)).toBe('dismiss');
  });

  it('direction always follows the offset sign, not the velocity sign', () => {
    // Offset dominant: a positive offset past the distance threshold accepts
    // even if velocity happens to read near zero.
    expect(resolveSwipeDecision(120, 0.001)).toBe('accept');
    expect(resolveSwipeDecision(-120, -0.001)).toBe('dismiss');
  });

  it('never fires on a flick whose velocity direction disagrees with the net offset (review fix)', () => {
    // A user drags right 30px (short of the 96px distance bar) then flicks
    // back left at release — the final motion means "cancel," not "accept."
    // |velocity| alone used to qualify this as a flick and resolved by the
    // (unrelated) offset sign, filing the opposite of the user's intent.
    expect(resolveSwipeDecision(30, -800)).toBeNull();
    expect(resolveSwipeDecision(-30, 800)).toBeNull();
  });

  it('still resolves a genuine short flick when velocity direction agrees with the offset', () => {
    expect(resolveSwipeDecision(30, 800)).toBe('accept');
    expect(resolveSwipeDecision(-30, -800)).toBe('dismiss');
  });
});
