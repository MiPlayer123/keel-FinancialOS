import { SCENARIOS } from '@keel/test-fixtures';
import { describe, expect, it } from 'vitest';
import { emptyIngestState, planStream, projectCanonicalState } from '@keel/ingest';

describe('scenario golden oracles', () => {
  it.each(Object.values(SCENARIOS))('$name matches the canonical projection', (scenario) => {
    const result = planStream(emptyIngestState(), scenario.pages, {
      provider: 'simulator',
      connectionExternalRef: scenario.connectionExternalRef,
    });

    expect(projectCanonicalState(result.nextState)).toEqual(scenario.expectedCanonical);
  });

  it.each(Object.values(SCENARIOS))('$name replays deterministically with only noops', (scenario) => {
    const ctx = {
      provider: 'simulator',
      connectionExternalRef: scenario.connectionExternalRef,
    };
    const first = planStream(emptyIngestState(), scenario.pages, ctx);
    const replay = planStream(first.nextState, scenario.pages, ctx);

    expect(projectCanonicalState(replay.nextState)).toEqual(
      projectCanonicalState(first.nextState),
    );
    expect(replay.actions.every((action) => action.type === 'noop')).toBe(true);
  });
});
