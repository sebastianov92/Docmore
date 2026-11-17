import "@/features/editor/styles/index.css";
import { useEffect, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { Container } from "@mantine/core";
import ReadonlyPageEditor from "@/features/editor/readonly-page-editor";

interface RenderData {
  pageId: string;
  title: string;
  content: any;
}

declare global {
  interface Window {
    __pdfReady?: boolean;
    __pdfError?: string;
  }
}

// What Gotenberg's Chromium prints: the page read-only, in print layout,
// authenticated by the token in the URL. It flags window.__pdfReady once
// fonts and images have had their chance, which is what Gotenberg waits for.
export default function PdfRenderPage() {
  const { pageId } = useParams<{ pageId: string }>();
  const [params] = useSearchParams();
  const token = params.get("token");
  const [data, setData] = useState<RenderData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!pageId || !token) {
      setError("Missing page or token");
      return;
    }
    fetch("/api/pdf-export/render", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pageId, token }),
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        return (json?.data ?? json) as RenderData;
      })
      .then(setData)
      .catch((err) => setError(err?.message ?? "Failed to load the page"));
  }, [pageId, token]);

  useEffect(() => {
    if (error) {
      window.__pdfError = error;
      window.__pdfReady = true;
    }
  }, [error]);

  useEffect(() => {
    if (!data) return;
    document.title = data.title || "Untitled";
    let cancelled = false;
    const settle = async () => {
      try {
        await document.fonts?.ready;
      } catch {
        /* fonts are optional */
      }
      const images = Array.from(document.images).filter((img) => !img.complete);
      await Promise.all(
        images.map(
          (img) =>
            new Promise<void>((resolve) => {
              img.addEventListener("load", () => resolve(), { once: true });
              img.addEventListener("error", () => resolve(), { once: true });
            }),
        ),
      );
      // One more frame for lazy views (code blocks, diagrams) to paint.
      await new Promise((resolve) => setTimeout(resolve, 400));
      if (!cancelled) window.__pdfReady = true;
    };
    void settle();
    return () => {
      cancelled = true;
    };
  }, [data]);

  if (error) {
    return <div style={{ padding: 24, fontFamily: "sans-serif" }}>{error}</div>;
  }
  if (!data) return null;

  return (
    <Container size={900} p={0}>
      <ReadonlyPageEditor key={data.pageId} title={data.title} content={data.content} pageId={data.pageId} printMode />
    </Container>
  );
}
