/**
 * Pure resolution of a horizontal drag/swipe gesture into an accept/dismiss
 * decision, shared by any swipeable suggest→approve card so the threshold
 * and direction mapping live in one tested place instead of inline in a
 * component's gesture handler (C17 — swipe review queue).
 *
 * Swipe is an ADDITION to the existing button-based accept/dismiss, never a
 * replacement (Law 8 accessibility) — this helper only decides what a
 * completed drag MEANS; the buttons keep working unconditionally regardless
 * of what this returns.
 *
 * Right = accept (mirrors the existing right-hand "Accept" button position
 * in CategorizationCard); left = dismiss.
 *
 * A drag resolves to a decision only when it clears one of two bars:
 *   - DISTANCE: the drag traveled far enough on its own, however slowly.
 *   - FLICK: a fast, deliberate flick — at least a small minimum distance
 *     (guards against a stray high-velocity reading on an effectively
 *     stationary pointer) AND a high velocity.
 * Anything short of both is a snap-back, not a decision — mirroring the
 * common "swipe to act" pattern (Mail, Gmail-style) where a short drag can
 * still act if released with speed, but jitter never fires an action.
 */

const DISTANCE_THRESHOLD_PX = 96;
const FLICK_MIN_DISTANCE_PX = 24;
const FLICK_VELOCITY_THRESHOLD_PX_PER_S = 500;

export type SwipeDecision = 'accept' | 'dismiss' | null;

export function resolveSwipeDecision(offsetX: number, velocityX: number): SwipeDecision {
  const absOffset = Math.abs(offsetX);

  // Below the flick floor entirely: too small to be an intentional gesture,
  // regardless of any velocity reading.
  if (absOffset < FLICK_MIN_DISTANCE_PX) return null;

  const passedDistance = absOffset >= DISTANCE_THRESHOLD_PX;
  // Review finding: a flick's velocity must agree in direction with the net
  // offset — otherwise a drag-right-then-flick-back-left release (e.g.
  // offsetX=30, velocityX=-800, someone pulling back to cancel) qualified on
  // |velocity| alone and resolved by the (unrelated) offset sign, filing the
  // opposite of what the user's final motion meant.
  const passedFlick =
    Math.abs(velocityX) >= FLICK_VELOCITY_THRESHOLD_PX_PER_S && Math.sign(velocityX) === Math.sign(offsetX);
  if (!passedDistance && !passedFlick) return null;

  return offsetX > 0 ? 'accept' : 'dismiss';
}
