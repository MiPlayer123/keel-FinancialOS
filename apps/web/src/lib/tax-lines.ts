/**
 * IRS tax lines a category can map to (mirrors the `tax_line` Postgres enum in
 * 20260713130000_tax_lines.sql — keep in sync). Mapping is user-set only;
 * KEEL never infers a tax position (explicit ownership, BC-v2.1 §9.1).
 */
export const TAX_LINES: { value: string; label: string; schedule: string }[] = [
  { value: 'w2_wages', label: 'W-2 wages', schedule: 'Income' },
  { value: 'interest_income', label: 'Interest income', schedule: 'Schedule B' },
  { value: 'dividend_income', label: 'Dividends', schedule: 'Schedule B' },
  { value: 'capital_gains', label: 'Capital gains', schedule: 'Schedule D' },
  { value: 'self_employment_income', label: 'Self-employment income', schedule: 'Schedule C' },
  { value: 'other_income', label: 'Other income', schedule: 'Income' },
  { value: 'hsa_contribution', label: 'HSA contribution', schedule: 'Adjustments' },
  { value: 'ira_contribution', label: 'IRA contribution', schedule: 'Adjustments' },
  { value: 'student_loan_interest', label: 'Student loan interest', schedule: 'Adjustments' },
  { value: 'charitable_contributions', label: 'Charitable contributions', schedule: 'Schedule A' },
  { value: 'medical_expenses', label: 'Medical expenses', schedule: 'Schedule A' },
  { value: 'mortgage_interest', label: 'Mortgage interest', schedule: 'Schedule A' },
  { value: 'state_local_income_taxes', label: 'State/local income taxes', schedule: 'Schedule A' },
  { value: 'property_taxes', label: 'Property taxes', schedule: 'Schedule A' },
  { value: 'business_expense', label: 'Business expense', schedule: 'Schedule C' },
  { value: 'estimated_tax_payments', label: 'Estimated tax payments', schedule: 'Payments' },
  { value: 'federal_tax_withheld', label: 'Federal tax withheld', schedule: 'Payments' },
  { value: 'state_tax_withheld', label: 'State tax withheld', schedule: 'Payments' },
];

const byValue = new Map(TAX_LINES.map((t) => [t.value, t]));

export function taxLineLabel(value: string): string {
  return byValue.get(value)?.label ?? value;
}

export function taxLineSchedule(value: string): string {
  return byValue.get(value)?.schedule ?? 'Other';
}
