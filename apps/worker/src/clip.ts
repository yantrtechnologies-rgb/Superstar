import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  AssetStorageError, finalizeAiJob, prisma, readStudioJobVideo, uploadVideo, validClipRange, videoLimit,
} from '@cadencedesk/data';

const exec = promisify(execFile);
const movInput = ['-protocol_whitelist', 'file', '-f', 'mov', '-enable_drefs', '0', '-use_absolute_path', '0'];

class ClipError extends Error {}

async function run(binary: string, args: string[], cwd: string, timeout: number) {
  return exec(binary, args, {
    cwd, timeout, windowsHide: true, maxBuffer: 64 * 1024,
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      TMPDIR: cwd,
    },
  });
}

export async function checkMediaTools() {
  await Promise.all([
    run(process.env.FFMPEG_PATH ?? 'ffmpeg', ['-version'], tmpdir(), 5000),
    run(process.env.FFPROBE_PATH ?? 'ffprobe', ['-version'], tmpdir(), 5000),
  ]);
}

async function probe(path: string, directory: string) {
  const { stdout } = await run(process.env.FFPROBE_PATH ?? 'ffprobe', [
    '-v', 'error', ...movInput, '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', path,
  ], directory, 10_000);
  const data = JSON.parse(stdout) as {
    format?: { duration?: string }; streams?: { codec_type?: string; width?: number; height?: number }[];
  };
  const duration = Number(data.format?.duration);
  const video = data.streams?.find((stream) => stream.codec_type === 'video');
  const width = video?.width ?? 0;
  const height = video?.height ?? 0;
  if (!Number.isFinite(duration) || duration <= 0 || width <= 0 || height <= 0 || width * height > 16_777_216) {
    throw new ClipError('The file needs a supported video track and duration.');
  }
  return { duration, width, height };
}

export async function createClip(bytes: Uint8Array<ArrayBuffer>, start: number, duration: number) {
  if (!validClipRange(start, duration)) throw new ClipError('Choose a clip of 1 to 60 seconds.');
  const directory = await mkdtemp(join(tmpdir(), 'cadencedesk-clip-'));
  const input = join(directory, 'source.mp4');
  const output = join(directory, 'clip.mp4');
  try {
    await writeFile(input, bytes, { flag: 'wx' });
    const source = await probe(input, directory);
    if (start + duration > source.duration + 0.05) {
      throw new ClipError('The clip range exceeds the duration of the source video.');
    }
    await run(process.env.FFMPEG_PATH ?? 'ffmpeg', [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-threads', '2', '-filter_threads', '1',
      ...movInput, '-ss', String(start), '-i', input, '-t', String(duration),
      '-map', '0:v:0', '-map', '0:a:0?', '-map_metadata', '-1', '-map_chapters', '-1',
      '-vf', "scale=w='min(720,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
      '-r', '30', '-c:v', 'libx264', '-preset', 'fast', '-threads', '2',
      '-b:v', '1400k', '-maxrate', '1800k', '-bufsize', '2M', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', '-fs', String(videoLimit),
      '-f', 'mp4', output,
    ], directory, 70_000);
    const result = await probe(output, directory);
    if (Math.abs(result.duration - duration) > 0.25 || (await stat(output)).size >= videoLimit) {
      throw new ClipError('The clip exceeded processing limits.');
    }
    return Uint8Array.from(await readFile(output));
  } catch (error) {
    if (error instanceof ClipError) throw error;
    throw new ClipError('FFmpeg could not process the MP4 within the worker limits.');
  } finally {
    await Promise.all([rm(input, { force: true }), rm(output, { force: true })]);
    await rmdir(directory);
  }
}

export async function processMediaClip(id: string) {
  const [job] = await prisma.aiJob.updateManyAndReturn({
    where: { id, state: 'QUEUED', kind: 'CLIP' }, data: { state: 'RUNNING', startedAt: new Date() },
  });
  if (!job) return;
  try {
    if (job.startSecond === null || job.durationSeconds === null) throw new ClipError('The clip range is unavailable.');
    const source = await readStudioJobVideo(job.workspaceId, job.sourceAssetId);
    const bytes = await createClip(source, job.startSecond, job.durationSeconds);
    const stored = await uploadVideo(job.workspaceId, bytes);
    const label = `Clip ${job.startSecond}s to ${job.startSecond + job.durationSeconds}s`;
    await finalizeAiJob(id, { type: 'success', providerRef: null, asset: { ...stored, label } });
  } catch (error) {
    if (!(error instanceof ClipError || error instanceof AssetStorageError)) throw error;
    await finalizeAiJob(id, { type: 'failed', error: error.message });
  }
}
