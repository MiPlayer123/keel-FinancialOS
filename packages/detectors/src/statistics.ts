export const compareBigints = (left: bigint, right: bigint): number =>
  left === right ? 0 : left < right ? -1 : 1;

export const lowerMedian = (values: readonly bigint[]): bigint => {
  if (values.length === 0) throw new RangeError('median requires at least one value');
  const sorted = [...values].sort(compareBigints);
  return sorted[Math.floor((sorted.length - 1) / 2)] as bigint;
};

export const squaredResidualSum = (values: readonly bigint[], center: bigint): bigint =>
  values.reduce((sum, value) => {
    const residual = value - center;
    return sum + residual * residual;
  }, 0n);

export interface BigintSummary {
  readonly min: bigint;
  readonly max: bigint;
  readonly median: bigint;
  readonly squaredResidualSum: bigint;
  readonly count: number;
}

export const bigintSummary = (values: readonly bigint[]): BigintSummary => {
  const median = lowerMedian(values);
  let min = values[0] as bigint;
  let max = min;
  for (const value of values.slice(1)) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return {
    min,
    max,
    median,
    squaredResidualSum: squaredResidualSum(values, median),
    count: values.length,
  };
};
