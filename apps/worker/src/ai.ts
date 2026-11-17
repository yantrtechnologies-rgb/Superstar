import { AssetStorageError, finalizeAiJob, prisma, readStudioJobVideo, uploadImage } from '@cadencedesk/data';
import { Client, WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import { AiProviderError, generateContent, transcribeVideo } from './openai';

export async function runAiJob(id: string) {
  const [job] = await prisma.aiJob.updateManyAndReturn({
    where: { id, state: 'QUEUED', kind: { not: 'CLIP' } }, data: { state: 'RUNNING', startedAt: new Date() },
  });
  if (!job || job.kind === 'CLIP') return;
  let providerRef: string | null = null;
  try {
    const generation = job.kind === 'TRANSCRIBE'
      ? await transcribeVideo(job.model, await readStudioJobVideo(job.workspaceId, job.sourceAssetId))
      : await generateContent({ kind: job.kind, model: job.model, prompt: job.prompt });
    providerRef = generation.providerRef;
    const output = 'text' in generation
      ? { text: generation.text }
      : { asset: await uploadImage(job.workspaceId, generation.image) };
    await finalizeAiJob(id, { type: 'success', providerRef, ...output });
  } catch (error) {
    if (!(error instanceof AiProviderError || error instanceof AssetStorageError)) throw error;
    await finalizeAiJob(id, {
      type: 'failed', error: error.message,
      providerRef: error instanceof AiProviderError ? error.providerRef : providerRef,
    });
  }
}

export async function dispatchAiJobs(client: Client) {
  const jobs = await prisma.aiJob.findMany({
    where: { dispatchedAt: null, state: 'QUEUED' },
    orderBy: { createdAt: 'asc' }, take: 20, select: { id: true, kind: true },
  });
  for (const job of jobs) {
    try {
      await client.workflow.start(job.kind === 'CLIP' ? 'generateMediaClip' : 'generateAiContent', {
        taskQueue: 'cadencedesk', workflowId: 'ai-' + job.id,
        workflowIdReusePolicy: 'REJECT_DUPLICATE', args: [job.id],
      });
    } catch (error) {
      if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
    }
    await prisma.aiJob.updateMany({ where: { id: job.id, dispatchedAt: null }, data: { dispatchedAt: new Date() } });
  }
}

export async function reconcileAiJobs() {
  const stale = await prisma.aiJob.findMany({
    where: { state: 'RUNNING', startedAt: { lt: new Date(Date.now() - 5 * 60_000) } },
    take: 50, select: { id: true },
  });
  for (const { id } of stale) {
    await finalizeAiJob(id, { type: 'failed', error: 'Processing stopped before the result was saved.' });
  }
}
