import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge, Button, Group, Modal, ScrollArea, SimpleGrid, Stack, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconMicrophone, IconPlayerPause, IconPlayerPlay, IconPlayerStop } from "@tabler/icons-react";
import { getApiErrorMessage } from "@/lib/api-error";
import { nativeCall, nativeCan } from "@/lib/native/bridge.ts";
import {
  IMeetingItem,
  IMeetingSegment,
  MEETING_RECORDER_EVENT,
  MeetingItemOp,
  discardLiveMeeting,
  editMeetingItem,
  startLiveMeeting,
  transcribeLiveChunk,
  transcribeMeeting,
  updateLiveMeeting,
} from "../services";
import { MeetingItemsList, MeetingListState } from "./meeting-items-list";

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

// Records an in-person meeting from the microphone: one recorder keeps the
// whole file, a second one restarts every 45 seconds so each piece is
// transcribed as the meeting runs; the server keeps the list of agreements
// and tasks from that text. Stop sends the full recording to become the notes.
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
  // the list of agreements and tasks the server keeps while the meeting runs
  const [items, setItems] = useState<IMeetingItem[]>([]);
  const [listState, setListState] = useState<MeetingListState>("none");
  const meetingRef = useRef<string | null>(null);
  const segmentsRef = useRef<IMeetingSegment[]>([]);
  // the first segment the server does not have yet
  const dirtyFromRef = useRef(0);
  const sendingRef = useRef(false);

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

  // Sends the text the server has not got; one call at a time, and what
  // arrives meanwhile goes with the next one.
  const pushLive = useCallback(async () => {
    const meetingId = meetingRef.current;
    if (!meetingId || sendingRef.current) return;
    sendingRef.current = true;
    try {
      while (meetingRef.current === meetingId && dirtyFromRef.current < segmentsRef.current.length) {
        const from = dirtyFromRef.current;
        const all = segmentsRef.current;
        dirtyFromRef.current = all.length;
        setListState((prev) => (prev === "unavailable" ? prev : "building"));
        try {
          const list = await updateLiveMeeting(meetingId, from, all.slice(from), now() / 1000);
          if (meetingRef.current !== meetingId) return;
          setItems(list.items);
          setListState(list.aiAvailable ? "waiting" : "unavailable");
        } catch {
          // nothing is lost: the same text goes again with the next piece
          dirtyFromRef.current = Math.min(dirtyFromRef.current, from);
          setListState("unavailable");
          return;
        }
      }
    } finally {
      sendingRef.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const addSegment = useCallback(
    (at: number, text: string) => {
      const segment = { start: at / 1000, end: (at + CHUNK_MS) / 1000, text };
      // pieces can come back out of order
      const list = segmentsRef.current;
      let index = list.length;
      while (index > 0 && list[index - 1].start > segment.start) index -= 1;
      list.splice(index, 0, segment);
      dirtyFromRef.current = Math.min(dirtyFromRef.current, index);
      void pushLive();
    },
    [pushLive],
  );

  const editItem = useCallback(
    async (op: MeetingItemOp) => {
      const meetingId = meetingRef.current;
      if (!meetingId) return;
      try {
        const list = await editMeetingItem(meetingId, op);
        if (meetingRef.current === meetingId) setItems(list.items);
      } catch (err) {
        setError(getApiErrorMessage(err, t("Could not change the list")));
      }
    },
    [t],
  );

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
        if (r.text.trim()) {
          setLines((prev) => [...prev, { at, text: r.text.trim() }].sort((a, b) => a.at - b.at));
          addSegment(at, r.text.trim());
        }
      } catch (err) {
        setError(getApiErrorMessage(err, t("Live transcription failed")));
      } finally {
        pendingRef.current -= 1;
      }
    };
    rec.start();
    liveRef.current = rec;
  }, [t, addSegment]);

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
      setItems([]);
      segmentsRef.current = [];
      dirtyFromRef.current = 0;
      meetingRef.current = null;
      setListState("none");
      setStatus("recording");
      // the list is a bonus: the recording goes on without it
      if (pageId) {
        startLiveMeeting({ pageId, mode: "in_person" })
          .then((meeting) => {
            if (!streamRef.current) {
              void discardLiveMeeting(meeting.id).catch(() => undefined);
              return;
            }
            meetingRef.current = meeting.id;
            setListState(meeting.aiAvailable ? "waiting" : "unavailable");
            void pushLive();
          })
          .catch(() => setListState("none"));
      }
      startLivePiece();
      liveTimerRef.current = setInterval(rotateLive, CHUNK_MS);
      tickRef.current = setInterval(() => setElapsed(now()), 1000);
    } catch (err: any) {
      setError(err?.name === "NotAllowedError" ? t("Microphone access was refused") : getApiErrorMessage(err, t("Could not start recording")));
      cleanup();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startLivePiece, rotateLive, cleanup, t, pageId, pushLive]);

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
      await transcribeMeeting(file, { pageId, meetingId: meetingRef.current ?? undefined, mode: "in_person" });
      notifications.show({ message: t("Recording sent. The notes will be added to this page when ready; you will be told.") });
      meetingRef.current = null;
      setPageId(null);
      setStatus("idle");
      setLines([]);
      setItems([]);
      setListState("none");
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
    if (meetingRef.current) void discardLiveMeeting(meetingRef.current).catch(() => undefined);
    meetingRef.current = null;
    setStatus("idle");
    setLines([]);
    setItems([]);
    setListState("none");
    setPageId(null);
  };

  useEffect(() => () => cleanup(), [cleanup]);

  const open = Boolean(pageId);
  return (
    <Modal opened={open} onClose={status === "idle" ? () => setPageId(null) : discard} title={t("Record meeting")} size="xl" closeOnClickOutside={false} data-testid="meeting-recorder">
      <Stack gap="sm">
        <Text size="sm" c="dimmed">
          {t("In-person meeting: the microphone is recorded in the browser. Every 45 seconds a piece is transcribed and the agreements and tasks are kept up to date; when you stop, the whole recording becomes notes on this page. For a call, the Docmore app for Mac records the other side from the call's own audio.")}
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
        <SimpleGrid cols={{ base: 1, sm: listState === "none" ? 1 : 2 }} spacing="sm">
          <Stack gap={4}>
            <Text size="xs" fw={600} c="dimmed" tt="uppercase">
              {t("Transcript")}
            </Text>
            <ScrollArea h={300} style={{ border: "1px solid var(--mantine-color-default-border)", borderRadius: 8, padding: 8 }}>
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
          </Stack>
          {listState !== "none" && (
            <Stack gap={4}>
              <Text size="xs" fw={600} c="dimmed" tt="uppercase">
                {t("Agreements and tasks")}
              </Text>
              <ScrollArea h={300} style={{ border: "1px solid var(--mantine-color-default-border)", borderRadius: 8, padding: 4 }}>
                <MeetingItemsList items={items} state={listState} onOp={status === "saving" ? undefined : editItem} />
              </ScrollArea>
            </Stack>
          )}
        </SimpleGrid>
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
