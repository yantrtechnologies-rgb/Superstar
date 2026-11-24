import { cookies } from 'next/headers';

/** The paid plan picked on the pricing page, remembered for an hour so sign-up can continue to payment. */
export const chosenPlanCookie = 'superstar_plan';
export type ChosenPlan = 'creator' | 'team' | 'agency';

export async function readChosenPlan(): Promise<ChosenPlan | null> {
  const value = (await cookies()).get(chosenPlanCookie)?.value;
  return value === 'creator' || value === 'team' || value === 'agency' ? value : null;
}
