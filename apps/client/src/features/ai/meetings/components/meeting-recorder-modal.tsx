import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge, Button, Group, Modal, ScrollArea, Stack, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconMicrophone, IconPlayerPause, IconPlayerPlay, IconPlayerStop } from "@tabler/icons-react";
import { getApiErrorMessage } from "@/lib/api-error";
import { nativeCall, nativeCan } from "@/lib/native/bridge.ts";
import { MEETING_RECORDER_EVENT, transcribeLiveChunk, transcribeMeeting } from "../services";

type Status = "idle" | "recording" | "paused" | "saving";
type Line = { at: number; text: string };

const CHUNK_MS = 45_000;

function pickMime(): string {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
  return candidates.find((m) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m)) ?? "";
}

function extOf(mime: string): string {
  if (mime.includes("mp4")) return "m4a";
  if (mime.includes("ogg")) return "ogg";
  return "webm";
}

function stamp(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

// Records the meeting from the microphone: one recorder keeps the whole
// file, a second one restarts every 45 seconds so each piece is transcribed
// as the meeting runs. Stop sends the full recording to become the notes.
export function MeetingRecorderModal() {
  const { t } = useTranslation();
  const [pageId, setPageId] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [lines, setLines] = useState<Line[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fullRef = useRef<MediaRecorder | null>(null);
  const liveRef = useRef<MediaRecorder | null>(null);
  const partsRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);
  const pausedAtRef = useRef(0);
  const pausedTotalRef = useRef(0);
  const mimeRef = useRef("");
  const liveTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pendingRef = useRef(0);

  useEffect(() => {
    const onOpen = (e: Event) => {
      const id = ((e as CustomEvent).detail?.pageId as string) ?? null;
      // The desktop app records the microphone and the system audio itself
      // and transcribes on the device.
      if (nativeCan("meetings")) {
        if (!id) return;
        nativeCall("meeting.start", { pageId: id }).catch((err: Error) =>
          notifications.show({ color: "red", message: err.message }),
        );
        return;
      }
      setPageId(id);
    };
    window.addEventListener(MEETING_RECORDER_EVENT, onOpen);
    return () => window.removeEventListener(MEETING_RECORDER_EVENT, onOpen);
  }, []);

  const now = () => Date.now() - startedAtRef.current - pausedTotalRef.current;

  const cleanup = useCallback(() => {
    if (liveTimerRef.current) clearInterval(liveTimerRef.current);
    if (tickRef.current) clearInterval(tickRef.current);
    liveTimerRef.current = null;
    tickRef.current = null;
    streamRef.current?.getTracks().forEach((tr) => tr.stop());
    streamRef.current = null;
    fullRef.current = null;
    liveRef.current = null;
  }, []);

  // one live recorder per piece: each blob stands on its own
  const startLivePiece = useCallback(() => {
    const stream = streamRef.current;
    if (!stream) return;
    const rec = new MediaRecorder(stream, mimeRef.current ? { mimeType: mimeRef.current } : undefined);
    const at = now();
    rec.ondataavailable = async (ev) => {
      if (!ev.data || ev.data.size < 2000) return;
      pendingRef.current += 1;
      try {
        const r = await transcribeLiveChunk(ev.data, `live.${extOf(mimeRef.current)}`);
        if (r.text.trim()) setLines((prev) => [...prev, { at, text: r.text.trim() }]);
      } catch (err) {
        setError(getApiErrorMessage(err, t("Live transcription failed")));
      } finally {
        pendingRef.current -= 1;
      }
    };
    rec.start();
    liveRef.current = rec;
  }, [t]);

  const rotateLive = useCallback(() => {
    const rec = liveRef.current;
    if (rec && rec.state === "recording") rec.stop();
    startLivePiece();
  }, [startLivePiece]);

  const start = useCallback(async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      mimeRef.current = pickMime();
      partsRef.current = [];
      const full = new MediaRecorder(stream, mimeRef.current ? { mimeType: mimeRef.current } : undefined);
      full.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) partsRef.current.push(ev.data);
      };
      full.start(1000);
      fullRef.current = full;
      startedAtRef.current = Date.now();
      pausedTotalRef.current = 0;
      setElapsed(0);
      setLines([]);
      setStatus("recording");
      startLivePiece();
      liveTimerRef.current = setInterval(rotateLive, CHUNK_MS);
      tickRef.current = setInterval(() => setElapsed(now()), 1000);
    } catch (err: any) {
      setError(err?.name === "NotAllowedError" ? t("Microphone access was refused") : getApiErrorMessage(err, t("Could not start recording")));
      cleanup();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startLivePiece, rotateLive, cleanup, t]);

  const pause = () => {
    fullRef.current?.pause();
    liveRef.current?.pause();
    pausedAtRef.current = Date.now();
    setStatus("paused");
  };
  const resume = () => {
    pausedTotalRef.current += Date.now() - pausedAtRef.current;
    fullRef.current?.resume();
    liveRef.current?.resume();
    setStatus("recording");
  };

  const stop = useCallback(async () => {
    if (!fullRef.current) return;
    setStatus("saving");
    const full = fullRef.current;
    const live = liveRef.current;
    if (liveTimerRef.current) clearInterval(liveTimerRef.current);
    if (tickRef.current) clearInterval(tickRef.current);
    await new Promise<void>((resolve) => {
      full.onstop = () => resolve();
      full.stop();
    });
    if (live && live.state !== "inactive") live.stop();
    const blob = new Blob(partsRef.current, { type: mimeRef.current || "audio/webm" });
    streamRef.current?.getTracks().forEach((tr) => tr.stop());
    try {
      if (!pageId) throw new Error("No page");
      const file = new File([blob], `meeting-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.${extOf(mimeRef.current)}`, { type: blob.type });
      await transcribeMeeting(file, { pageId });
      notifications.show({ message: t("Recording sent. The notes will be added to this page when ready; you will be told.") });
      setPageId(null);
      setStatus("idle");
      setLines([]);
    } catch (err) {
      setError(getApiErrorMessage(err, t("Could not send the recording")));
      setStatus("idle");
    } finally {
      cleanup();
    }
  }, [pageId, cleanup, t]);

  const discard = () => {
    fullRef.current?.state !== "inactive" && fullRef.current?.stop();
    liveRef.current?.state !== "inactive" && liveRef.current?.stop();
    cleanup();
    setStatus("idle");
    setLines([]);
    setPageId(null);
  };

  useEffect(() => () => cleanup(), [cleanup]);

  const open = Boolean(pageId);
  return (
    <Modal opened={open} onClose={status === "idle" ? () => setPageId(null) : discard} title={t("Record meeting")} size="lg" closeOnClickOutside={false} data-testid="meeting-recorder">
      <Stack gap="sm">
        <Text size="sm" c="dimmed">
          {t("The microphone is recorded in the browser. Every 45 seconds a piece is transcribed and shown here; when you stop, the whole recording becomes notes on this page.")}
        </Text>
        <Group gap="sm" align="center">
          {status === "idle" && (
            <Button leftSection={<IconMicrophone size={16} />} onClick={start} data-testid="meeting-start">
              {t("Start recording")}
            </Button>
          )}
          {status === "recording" && (
            <>
              <Badge color="red" variant="filled" leftSection={<IconMicrophone size={12} />}>
                {t("Recording")} {stamp(elapsed)}
              </Badge>
              <Button size="xs" variant="default" leftSection={<IconPlayerPause size={14} />} onClick={pause}>
                {t("Pause")}
              </Button>
            </>
          )}
          {status === "paused" && (
            <>
              <Badge color="gray" variant="filled">
                {t("Paused")} {stamp(elapsed)}
              </Badge>
              <Button size="xs" variant="default" leftSection={<IconPlayerPlay size={14} />} onClick={resume}>
                {t("Resume")}
              </Button>
            </>
          )}
          {(status === "recording" || status === "paused") && (
            <Button size="xs" color="red" leftSection={<IconPlayerStop size={14} />} onClick={stop} data-testid="meeting-stop">
              {t("Stop and make notes")}
            </Button>
          )}
          {status === "saving" && <Text size="sm">{t("Sending the recording…")}</Text>}
        </Group>
        {error && (
          <Text size="sm" c="red">
            {error}
          </Text>
        )}
        <ScrollArea h={260} style={{ border: "1px solid var(--mantine-color-default-border)", borderRadius: 8, padding: 8 }}>
          {lines.length === 0 ? (
            <Text size="sm" c="dimmed">
              {status === "idle" ? t("Nothing recorded yet.") : t("Listening… the first text shows after about a minute.")}
            </Text>
          ) : (
            <Stack gap={6}>
              {lines.map((l, i) => (
                <Text key={i} size="sm">
                  <Text span c="dimmed" size="xs" mr={6}>
                    [{stamp(l.at)}]
                  </Text>
                  {l.text}
                </Text>
              ))}
            </Stack>
          )}
        </ScrollArea>
        {status !== "idle" && status !== "saving" && (
          <Group justify="flex-end">
            <Button size="xs" variant="subtle" color="gray" onClick={discard}>
              {t("Discard")}
            </Button>
          </Group>
        )}
      </Stack>
    </Modal>
  );
}
