import { aiQuote, assetStorageConfigured, clippingConfigured } from '@cadencedesk/data';
import { randomUUID } from 'node:crypto';
import { clipVideoAction, transcribeVideoAction, uploadStudioVideoAction } from './actions';

type Video = { id: string; label: string | null };

function VideoPicker({ videos, id }: { videos: Video[]; id: string }) {
  return (
    <>
      <label htmlFor={id}>Source video</label>
      <select id={id} name="sourceAssetId" required>
        <option value="">Choose a video</option>
        {videos.map((video) => <option key={video.id} value={video.id}>{video.label ?? 'Workspace video'}</option>)}
      </select>
    </>
  );
}

export function VideoStudio({ workspace, videos, canWrite }: { workspace: string; videos: Video[]; canWrite: boolean }) {
  const transcript = aiQuote('TRANSCRIBE');
  return (
    <section>
      <h2>Workspace video</h2>
      {canWrite && (assetStorageConfigured() ? (
        <form action={uploadStudioVideoAction} className="identity-form">
          <input type="hidden" name="workspace" value={workspace} />
          <label htmlFor="studio-video">MP4 video up to 20 MiB</label>
          <input id="studio-video" name="video" type="file" accept="video/mp4,.mp4" required />
          <button type="submit">Upload video</button>
        </form>
      ) : <p>Ask your operator to configure video storage.</p>)}
      {videos.length > 0 && <ul className="workspaces-list">{videos.map((video) => (
        <li key={video.id}>
          <span>{video.label ?? 'Workspace video'}</span>
          <a href={`/app/${workspace}/studio/assets/${video.id}`}>Download video</a>
        </li>
      ))}</ul>}
      {canWrite && videos.length > 0 && <ul className="post-list">
        <li><article>
          <h2>Clip video</h2>
          {clippingConfigured() ? (
            <form action={clipVideoAction} className="identity-form">
              <input type="hidden" name="workspace" value={workspace} />
              <input type="hidden" name="requestId" value={randomUUID()} />
              <VideoPicker videos={videos} id="clip-source" />
              <label htmlFor="clip-start">Start time in seconds</label>
              <input id="clip-start" type="number" name="start" min="0" max="3600" step="1" defaultValue="0" required />
              <label htmlFor="clip-duration">Duration in seconds</label>
              <input id="clip-duration" type="number" name="duration" min="1" max="60" step="1" defaultValue="15" required />
              <button type="submit">Create clip</button>
            </form>
          ) : <p>Ask your operator to enable the FFmpeg media worker.</p>}
        </article></li>
        <li><article>
          <h2>Transcribe audio</h2>
          {transcript ? (
            <form action={transcribeVideoAction} className="identity-form">
              <input type="hidden" name="workspace" value={workspace} />
              <input type="hidden" name="requestId" value={randomUUID()} />
              <input type="hidden" name="credits" value={transcript.credits} />
              <VideoPicker videos={videos} id="transcript-source" />
              <p>Transcription sends the selected MP4 to the configured OpenAI project.</p>
              <button type="submit">Start transcription · {transcript.credits} credits</button>
            </form>
          ) : <p>Ask your operator to configure a transcription model and credit quote.</p>}
        </article></li>
      </ul>}
    </section>
  );
}
