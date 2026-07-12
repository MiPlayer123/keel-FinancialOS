import { BaseSequencer, type TestSpecification } from 'vitest/node';

/** Shared-DB integration files are numbered dependencies, not duration jobs. */
export class NumericSequencer extends BaseSequencer {
  override sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    return Promise.resolve(
      [...files].sort((left, right) => left.moduleId.localeCompare(right.moduleId, 'en')),
    );
  }
}
