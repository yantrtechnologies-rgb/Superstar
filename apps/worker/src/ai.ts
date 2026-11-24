import { AssetStorageError, finalizeAiJob, prisma, readStudioJobVideo, uploadImage, uploadVideo } from '@cadencedesk/data';
import { Client, WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import { geminiImage, geminiText, geminiTranscribe, geminiVideo } from './gemini';
import { AiProviderError, generateContent, transcribeVideo } from './openai';

type Generated = { providerRef: string | null } & (
  { text: string } | { image: Uint8Array<ArrayBuffer> } | { video: Uint8Array<ArrayBuffer> });

async function generate(job: { kind: string; model: string; prompt: string; workspaceId: string; sourceAssetId: string | null }): Promise<Generated> {
  const gemini = job.model.startsWith('gemini');
  if (job.kind === 'TRANSCRIBE') {
    const video = await readStudioJobVideo(job.workspaceId, job.sourceAssetId);
    return gemini ? geminiTranscribe(job.model, video) : transcribeVideo(job.model, video);
  }
  if (job.kind === 'VIDEO') {
    if (!gemini) throw new AiProviderError('Video generation needs the Gemini provider.');
    return geminiVideo(job.model, job.prompt);
  }
  if (gemini) return job.kind === 'TEXT' ? geminiText(job.model, job.prompt) : geminiImage(job.model, job.prompt);
  return generateContent({ kind: job.kind as 'TEXT' | 'IMAGE', model: job.model, prompt: job.prompt });
}

export async function runAiJob(id: string) {
  const [job] = await prisma.aiJob.updateManyAndReturn({
    where: { id, state: 'QUEUED', kind: { not: 'CLIP' } }, data: { state: 'RUNNING', startedAt: new Date() },
  });
  if (!job || job.kind === 'CLIP') return;
  let providerRef: string | null = null;
  try {
    const generation = await generate(job);
    providerRef = generation.providerRef;
    const label = job.prompt.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 80) || 'AI generation';
    const output = 'text' in generation
      ? { text: generation.text }
      : 'image' in generation
        ? { asset: { ...await uploadImage(job.workspaceId, generation.image), label } }
        : { asset: { ...await uploadVideo(job.workspaceId, generation.video), label } };
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
    const workflow = job.kind === 'CLIP' ? 'generateMediaClip' : job.kind === 'VIDEO' ? 'generateAiVideo' : 'generateAiContent';
    try {
      await client.workflow.start(workflow, {
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
  // Video generation can legitimately run for several minutes; other jobs finish well within five.
  const stale = await prisma.aiJob.findMany({
    where: {
      state: 'RUNNING',
      OR: [
        { kind: { not: 'VIDEO' }, startedAt: { lt: new Date(Date.now() - 5 * 60_000) } },
        { kind: 'VIDEO', startedAt: { lt: new Date(Date.now() - 20 * 60_000) } },
      ],
    },
    take: 50, select: { id: true },
  });
  for (const { id } of stale) {
    await finalizeAiJob(id, { type: 'failed', error: 'Processing stopped before the result was saved.' });
  }
}
