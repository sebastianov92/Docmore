import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { AiSettingsService } from '../ai-settings.service';
import { AiProviderService } from '../ai-provider.service';
import { PROVIDER_LABELS } from '../ai.constants';

export interface TranscriptSegment {
  start: number; // seconds
  end: number;
  text: string;
}

export interface Transcript {
  text: string;
  segments: TranscriptSegment[];
  language: string | null;
  durationSeconds: number | null;
}

const TIMEOUT_MS = 15 * 60 * 1000;

// Speech to text with the workspace's transcription choice: an
// OpenAI-compatible /audio/transcriptions endpoint (OpenAI, Groq, a local
// Whisper server) or a Gemini model that listens to the file itself.
@Injectable()
export class AiTranscriptionService {
  private readonly logger = new Logger(AiTranscriptionService.name);

  constructor(
    private readonly settings: AiSettingsService,
    private readonly providers: AiProviderService,
  ) {}

  async isConfigured(workspaceId: string): Promise<boolean> {
    return Boolean((await this.settings.load(workspaceId)).transcription);
  }

  async transcribe(workspaceId: string, audio: Buffer, fileName: string, mimeType: string): Promise<Transcript> {
    const choice = (await this.settings.load(workspaceId)).transcription;
    if (!choice) {
      throw new BadRequestException('No transcription model is set. An admin can pick one under Settings > AI.');
    }
    if (choice.provider === 'gemini') return this.withGemini(workspaceId, choice as { provider: 'gemini'; model: string }, audio, mimeType);
    if (choice.provider === 'openai' || choice.provider === 'compatible') {
      return this.withAudioEndpoint(workspaceId, choice as { provider: 'openai' | 'compatible'; model: string }, audio, fileName, mimeType);
    }
    throw new BadRequestException(`${PROVIDER_LABELS[choice.provider]} cannot transcribe audio`);
  }

  private async withAudioEndpoint(
    workspaceId: string,
    choice: { provider: 'openai' | 'compatible'; model: string },
    audio: Buffer,
    fileName: string,
    mimeType: string,
  ): Promise<Transcript> {
    const creds = await this.settings.credentials(workspaceId, choice.provider);
    if (!creds.baseUrl) throw new BadRequestException(`Set the base URL for ${PROVIDER_LABELS[choice.provider]} first`);
    const headers: Record<string, string> = creds.apiKey ? { Authorization: `Bearer ${creds.apiKey}` } : {};
    const url = `${creds.baseUrl.replace(/\/$/, '')}/audio/transcriptions`;
    // whisper-style models give segments with verbose_json; newer ones only json
    const formats = /whisper/i.test(choice.model) || choice.provider === 'compatible' ? ['verbose_json', 'json'] : ['json'];
    let lastError = '';
    for (const format of formats) {
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(audio)], { type: mimeType || 'application/octet-stream' }), fileName || 'audio');
      form.append('model', choice.model);
      form.append('response_format', format);
      if (format === 'verbose_json') form.append('timestamp_granularities[]', 'segment');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const res = await fetch(url, { method: 'POST', headers, body: form, signal: controller.signal });
        const text = await res.text();
        if (!res.ok) {
          lastError = `${res.status}: ${text.slice(0, 300)}`;
          if (res.status === 400 && format === 'verbose_json') continue;
          if (res.status === 401 || res.status === 403) throw new BadRequestException('The provider rejected the API key');
          throw new BadRequestException(`The transcription provider answered ${lastError}`);
        }
        const data = JSON.parse(text);
        return normalize(data);
      } catch (err: any) {
        if (err instanceof BadRequestException) throw err;
        if (err?.name === 'AbortError') throw new BadRequestException('The transcription took too long');
        lastError = err?.message ?? 'unknown error';
        this.logger.debug(`transcription failed: ${lastError}`);
      } finally {
        clearTimeout(timer);
      }
    }
    throw new BadRequestException(`Could not transcribe: ${lastError}`);
  }

  private async withGemini(workspaceId: string, choice: { provider: 'gemini'; model: string }, audio: Buffer, mimeType: string): Promise<Transcript> {
    const { generateText } = await import('ai');
    const model = await this.providers.languageModel(workspaceId, choice as any);
    const result = await generateText({
      model,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'file', data: audio, mediaType: mimeType || 'audio/mpeg' },
            {
              type: 'text',
              text:
                'Transcribe this recording word for word, in its own language. One line per utterance, each starting with the time it begins as [mm:ss]. ' +
                'Mark speaker changes as "Speaker 1:", "Speaker 2:" when you can tell them apart. Output only the transcript.',
            },
          ],
        },
      ],
      temperature: 0,
      maxOutputTokens: 16_000,
    });
    const segments: TranscriptSegment[] = [];
    for (const line of result.text.split('\n')) {
      const m = /^\s*\[(\d{1,2}):(\d{2})(?::(\d{2}))?\]\s*(.+)$/.exec(line);
      if (!m) continue;
      const start = m[3] ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : Number(m[1]) * 60 + Number(m[2]);
      segments.push({ start, end: start, text: m[4].trim() });
    }
    for (let i = 0; i < segments.length - 1; i += 1) segments[i].end = segments[i + 1].start;
    const text = segments.length ? segments.map((s) => s.text).join('\n') : result.text.trim();
    return { text, segments, language: null, durationSeconds: segments.length ? segments[segments.length - 1].start : null };
  }
}

function normalize(data: any): Transcript {
  const segments: TranscriptSegment[] = Array.isArray(data?.segments)
    ? data.segments
        .map((s: any) => ({ start: Number(s.start ?? 0), end: Number(s.end ?? s.start ?? 0), text: String(s.text ?? '').trim() }))
        .filter((s: TranscriptSegment) => s.text)
    : [];
  const text = String(data?.text ?? segments.map((s) => s.text).join(' ')).trim();
  return {
    text,
    segments,
    language: data?.language ? String(data.language) : null,
    durationSeconds: data?.duration ? Math.round(Number(data.duration)) : segments.length ? Math.round(segments[segments.length - 1].end) : null,
  };
}
