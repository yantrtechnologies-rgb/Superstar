import { ComposerPage } from '../composer-page';

export default async function NewPost({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace } = await params;
  return <ComposerPage workspace={workspace} />;
}
