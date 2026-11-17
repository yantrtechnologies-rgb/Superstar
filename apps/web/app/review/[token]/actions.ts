'use server';

import { respondToReview, WorkspaceAccessError } from '@cadencedesk/data';
import { redirect } from 'next/navigation';
import { z } from 'zod';

const response = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  decision: z.enum(['COMMENT', 'CHANGES', 'APPROVE']),
  body: z.string().max(2000),
});

export async function reviewResponseAction(form: FormData) {
  const data = response.safeParse({ token: form.get('token'), decision: form.get('decision'), body: form.get('body') });
  if (!data.success) redirect('/review/received?status=invalid');
  const { token, decision, body } = data.data;
  try {
    await respondToReview(token, decision, body);
  } catch (error) {
    if (error instanceof WorkspaceAccessError) redirect(`/review/${token}?status=invalid`);
    throw error;
  }
  redirect(decision === 'CHANGES' ? '/review/received' : `/review/${token}`);
}
