import { notFound } from 'next/navigation';
import { z } from 'zod';
import { ComposerPage } from '../../composer-page';

export default async function EditPost({ params, searchParams }: {
  params: Promise<{ workspace: string; id: string }>; searchParams: Promise<{ status?: string }>;
}) {
  const [{ workspace, id }, { status }] = await Promise.all([params, searchParams]);
  if (!z.uuid().safeParse(id).success) notFound();
  return <ComposerPage workspace={workspace} postId={id} status={status} />;
}
