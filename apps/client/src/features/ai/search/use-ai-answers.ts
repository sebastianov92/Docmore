import { useCallback, useEffect, useRef, useState } from "react";
import { streamAnswer } from "@/features/ai/services";
import { AiAnswerSource, AiAskParams } from "@/features/ai/types";

// State for AI Answers in the search dialog: ask once, watch the sources
// and the answer arrive, reset when the question changes.
export function useAiAnswers() {
  const abortRef = useRef<AbortController | null>(null);
  const [asked, setAsked] = useState(false);
  const [loading, setLoading] = useState(false);
  const [answer, setAnswer] = useState("");
  const [sources, setSources] = useState<AiAnswerSource[]>([]);
  const [error, setError] = useState<string | null>(null);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setAsked(false);
    setLoading(false);
    setAnswer("");
    setSources([]);
    setError(null);
  }, []);

  const ask = useCallback((params: AiAskParams) => {
    abortRef.current?.abort();
    setAsked(true);
    setLoading(true);
    setAnswer("");
    setSources([]);
    setError(null);
    abortRef.current = streamAnswer(params, {
      onSources: setSources,
      onChunk: (text) => setAnswer((prev) => prev + text),
      onDone: () => setLoading(false),
      onError: (message) => {
        setError(message);
        setLoading(false);
      },
    });
  }, []);

  useEffect(() => () => abortRef.current?.abort(), []);

  return { ask, reset, asked, loading, answer, sources, error };
}
