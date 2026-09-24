import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { usePaseo, useRpc } from "@getpaseo/plugin/client";
// Icon resolves names with Reflect.get() against the lucide module, so `name`
// must be the exported symbol (PascalCase, e.g. "Download") - not the kebab-case
// name from the Lucide website. An unknown name renders nothing, silently.
import { Icon, Modal, copyText, useToast } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { LayoutChangeEvent } from "react-native";
import {
  ActivityIndicator,
  Image,
  Modal as RNModal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import type { ImagePreviewData } from "../shared/image";
import { basename, isPreviewableImage, loadImageRpc, readChunkRpc } from "../shared/image";
import { base64ToBytes, canSaveFile, saveFile } from "./download";

const FETCH_MAX_WIDTH = 1024;

type Slide = { callId: string; filePath: string; fileName: string };

export function ImagePreviewItem({
  theme,
  layout,
  item,
  agentId,
}: PluginTimelineItemProps<ImagePreviewData>) {
  const { filePath, fileName, status, callId } = item.data;
  const [open, setOpen] = useState(false);
  const [selectedCallId, setSelectedCallId] = useState<string | null>(null);
  const [decodeFailed, setDecodeFailed] = useState(false);
  const [boxWidth, setBoxWidth] = useState(0);
  const [modalBoxWidth, setModalBoxWidth] = useState(0);
  const loadImage = useRpc(loadImageRpc);
  const readChunk = useRpc(readChunkRpc);
  const paseo = usePaseo();
  const toast = useToast();
  const window = useWindowDimensions();
  const isWeb = Platform.OS === "web";
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState(0);

  const query = useQuery({
    queryKey: ["image-preview", filePath, FETCH_MAX_WIDTH],
    queryFn: () => loadImage({ filePath, maxWidth: FETCH_MAX_WIDTH }),
    enabled: status === "completed",
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  const slidesQuery = useQuery({
    queryKey: ["image-preview-slides", agentId],
    enabled: open,
    staleTime: 30 * 1000,
    queryFn: async (): Promise<Slide[]> => {
      const entries: Array<{
        seqStart: number;
        item: { type: string; callId?: string; status?: string; detail?: { type: string; filePath?: string } };
      }> = [];
      let cursor: { epoch: string; seq: number } | null = null;
      for (;;) {
        const page = await paseo.agents.ref(agentId).timeline.refetch({
          direction: cursor ? "before" : "tail",
          ...(cursor ? { cursor } : {}),
          projection: "canonical",
          limit: 200,
        });
        if (page.error) throw new Error(page.error);
        entries.push(...page.entries);
        if (!page.hasOlder || !page.startCursor || page.startCursor.seq === cursor?.seq) break;
        cursor = page.startCursor;
      }
      return entries
        .filter((entry) =>
          entry.item.type === "tool_call" &&
          entry.item.status === "completed" &&
          entry.item.detail?.type === "read" &&
          typeof entry.item.detail.filePath === "string" &&
          isPreviewableImage(entry.item.detail.filePath),
        )
        .sort((first, second) => first.seqStart - second.seqStart)
        .map((entry) => ({
          callId: entry.item.callId!,
          filePath: entry.item.detail!.filePath!,
          fileName: basename(entry.item.detail!.filePath!),
        }));
    },
  });

  const slides = useMemo(() => slidesQuery.data ?? [], [slidesQuery.data]);
  const selectedIndex = slides.findIndex((slide) =>
    selectedCallId ? slide.callId === selectedCallId : slide.filePath === filePath,
  );
  const activeSlide = slides[selectedIndex] ?? { filePath, fileName };
  const activeFilePath = activeSlide.filePath;
  const activeFileName = activeSlide.fileName;
  const previewQuery = useQuery({
    queryKey: ["image-preview", activeFilePath, FETCH_MAX_WIDTH],
    queryFn: () => loadImage({ filePath: activeFilePath, maxWidth: FETCH_MAX_WIDTH }),
    enabled: open && status === "completed",
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  const navigate = useCallback((direction: -1 | 1) => {
    const next = slides[selectedIndex + direction];
    if (next) setSelectedCallId(next.callId);
  }, [slides, selectedIndex]);

  useEffect(() => {
    if (!open || !isWeb) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        event.stopPropagation();
        navigate(event.key === "ArrowLeft" ? -1 : 1);
      } else if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
      }
    };
    globalThis.window.addEventListener("keydown", onKeyDown, true);
    return () => globalThis.window.removeEventListener("keydown", onKeyDown, true);
  }, [open, isWeb, navigate]);

  const maxInlineHeight = layout.compact ? 280 : 360;

  const styles = useMemo(
    () => ({
      caption: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 6,
        paddingBottom: 4,
      },
      name: {
        color: theme.colors.foregroundMuted,
        fontSize: layout.compact ? 11 : 12,
        fontWeight: "500" as const,
        flexShrink: 1,
      },
      meta: {
        color: theme.colors.foregroundMuted,
        fontSize: layout.compact ? 11 : 12,
      },
      error: {
        color: theme.colors.statusDanger,
        fontSize: 12,
      },
      statusRow: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
        paddingVertical: 6,
      },
      actions: {
        flexDirection: "row" as const,
        flexWrap: "wrap" as const,
        gap: 8,
      },
      button: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 6,
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
      },
      buttonLabel: {
        color: theme.colors.foreground,
        fontSize: 13,
        fontWeight: "500" as const,
      },
      primaryButton: {
        borderColor: theme.colors.accent,
        backgroundColor: theme.colors.accent,
      },
      primaryLabel: {
        color: theme.colors.accentForeground,
      },
      path: {
        color: theme.colors.foregroundMuted,
        fontSize: 11,
      },
      webOverlay: {
        flex: 1,
        alignItems: "center" as const,
        justifyContent: "center" as const,
        backgroundColor: "rgba(0, 0, 0, 0.72)",
      },
      webCard: {
        maxWidth: "92%" as const,
        maxHeight: "92%" as const,
        // "stretch" (not "center") so header/image/path/actions all share the
        // card's own width, driven by its widest child - the image - instead
        // of each floating at its own natural size on the dark backdrop.
        alignItems: "stretch" as const,
        gap: 12,
        backgroundColor: theme.colors.surface2,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 14,
        padding: 16,
      },
      webHeader: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "space-between" as const,
        gap: 12,
      },
      webTitle: {
        color: theme.colors.foreground,
        fontSize: 14,
        fontWeight: "600" as const,
        flexShrink: 1,
      },
      webTitleGroup: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
        flexShrink: 1,
      },
      closeButton: {
        padding: 6,
        borderRadius: 6,
      },
      navigation: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "center" as const,
        gap: 16,
      },
      navigationButton: {
        padding: 10,
        borderRadius: 8,
        backgroundColor: theme.colors.surface1,
      },
    }),
    [theme, layout.compact],
  );

  const inlineAspectRatio =
    query.data?.width && query.data?.height ? query.data.width / query.data.height : undefined;
  const aspectRatio =
    previewQuery.data?.width && previewQuery.data?.height
      ? previewQuery.data.width / previewQuery.data.height
      : undefined;

  // Fit the box to the image instead of the image to the box, so there is never
  // any letterboxed dead space around it. Width is measured rather than assumed
  // because a percentage width cannot be capped by height in Yoga.
  const inlineImageStyle = useMemo(() => {
    if (!inlineAspectRatio || boxWidth <= 0) return undefined;
    const width = Math.min(boxWidth, maxInlineHeight * inlineAspectRatio);
    return {
      width,
      aspectRatio: inlineAspectRatio,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: theme.colors.border,
    };
  }, [inlineAspectRatio, boxWidth, maxInlineHeight, theme.colors.border]);

  // The Modal has no size prop (host-owned chrome, fixed width): requesting
  // width beyond what the content area actually measures just overflows and
  // clips instead of growing the dialog. Cap to the real measured width and
  // spend the modal's extra vertical room on height instead.
  const modalImageStyle = useMemo(() => {
    if (!aspectRatio || modalBoxWidth <= 0) return undefined;
    const width = Math.min(modalBoxWidth, window.height * 0.75 * aspectRatio);
    return { width, aspectRatio, borderRadius: 8 };
  }, [aspectRatio, modalBoxWidth, window.height]);

  // Web only: rendered inside RN's own Modal (a true full-screen canvas, not
  // the host's fixed-width dialog), so it is safe to size against the real
  // viewport with nothing to clip it.
  const fullscreenImageStyle = useMemo(() => {
    if (!aspectRatio) return undefined;
    const width = Math.min(window.width * 0.85, window.height * 0.7 * aspectRatio);
    return { width, aspectRatio, borderRadius: 8, alignSelf: "center" as const };
  }, [aspectRatio, window.width, window.height]);

  const onModalLayout = useCallback((event: LayoutChangeEvent) => {
    const next = event.nativeEvent.layout.width;
    setModalBoxWidth((previous) => (previous === next ? previous : next));
  }, []);

  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const next = event.nativeEvent.layout.width;
    setBoxWidth((previous) => (previous === next ? previous : next));
  }, []);

  const copy = useCallback(
    (text: string, label: string) => {
      copyText(text).then(
        () => toast.show(`${label} copied`, { variant: "success" }),
        (error: unknown) => toast.error(error instanceof Error ? error.message : "Copy failed"),
      );
    },
    [toast],
  );

  // Pulls the original file over the RPC channel in bounded chunks, because a
  // single oversized frame would silently kill the relay socket.
  const download = useCallback(() => {
    if (downloading) return;
    if (!canSaveFile()) {
      toast.error("Saving files is only supported in the Paseo web app.");
      return;
    }
    setDownloading(true);
    setProgress(0);
    const parts: Uint8Array[] = [];

    const pump = (offset: number): Promise<void> =>
      readChunk({ filePath: activeFilePath, offset }).then((result) => {
        if (result.error || result.base64 === null) {
          throw new Error(result.error ?? "Download failed.");
        }
        const bytes = base64ToBytes(result.base64);
        if (bytes.length === 0 && !result.eof) {
          throw new Error("Download stalled.");
        }
        parts.push(bytes);
        const received = offset + bytes.length;
        if (result.totalBytes) {
          setProgress(Math.min(1, received / result.totalBytes));
        }
        if (result.eof) {
          saveFile(parts, activeFileName, result.mimeType ?? "application/octet-stream");
          return;
        }
        return pump(received);
      });

    pump(0)
      .then(() => toast.show(`${activeFileName} saved`, { variant: "success" }))
      .catch((error: unknown) => {
        toast.error(error instanceof Error ? error.message : "Download failed");
      })
      .finally(() => setDownloading(false));
  }, [downloading, activeFileName, activeFilePath, readChunk, toast]);

  const sizeLabel =
    query.data?.width && query.data?.height ? `${query.data.width}×${query.data.height}` : null;

  let body: ReactNode;
  if (status === "running") {
    body = (
      <View style={styles.statusRow}>
        <ActivityIndicator color={theme.colors.accent} />
        <Text style={styles.meta}>Reading {fileName}…</Text>
      </View>
    );
  } else if (status !== "completed") {
    body = (
      <View style={styles.statusRow}>
        <Text style={styles.meta}>
          Read {status}: {fileName}
        </Text>
      </View>
    );
  } else if (query.isPending) {
    body = (
      <View style={styles.statusRow}>
        <ActivityIndicator color={theme.colors.accent} />
        <Text style={styles.meta}>Loading {fileName}…</Text>
      </View>
    );
  } else if (query.isError) {
    body = (
      <View style={styles.statusRow}>
        <Text style={styles.error}>
          {query.error instanceof Error ? query.error.message : "Preview failed."}
        </Text>
      </View>
    );
  } else if (query.data?.error || !query.data?.dataUri) {
    body = (
      <View style={styles.statusRow}>
        <Text style={styles.error}>{query.data?.error ?? "Preview unavailable."}</Text>
      </View>
    );
  } else if (decodeFailed) {
    body = (
      <View style={styles.statusRow}>
        <Text style={styles.error}>Image could not be decoded on this device.</Text>
      </View>
    );
  } else {
    body = (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Open ${fileName}`}
        onPress={() => {
          setSelectedCallId(callId ?? null);
          setOpen(true);
        }}
      >
        {inlineImageStyle ? (
          <Image
            source={{ uri: query.data.dataUri }}
            style={inlineImageStyle}
            accessibilityLabel={fileName}
            onError={() => setDecodeFailed(true)}
          />
        ) : null}
      </Pressable>
    );
  }

  const dataUri = previewQuery.data?.dataUri ?? null;

  const navigation = (
    <View style={styles.navigation}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Previous image"
        disabled={selectedIndex <= 0}
        style={[styles.navigationButton, { opacity: selectedIndex > 0 ? 1 : 0.4 }]}
        onPress={() => navigate(-1)}
      >
        <Icon name="ChevronLeft" size={20} color={theme.colors.foreground} />
      </Pressable>
      <Text style={styles.meta}>
        {slidesQuery.isPending
          ? "Loading slides…"
          : slidesQuery.isError
            ? "Slides unavailable"
            : selectedIndex < 0
              ? "Current image"
              : `${selectedIndex + 1} of ${slides.length}`}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Next image"
        disabled={selectedIndex < 0 || selectedIndex >= slides.length - 1}
        style={[
          styles.navigationButton,
          { opacity: selectedIndex >= 0 && selectedIndex < slides.length - 1 ? 1 : 0.4 },
        ]}
        onPress={() => navigate(1)}
      >
        <Icon name="ChevronRight" size={20} color={theme.colors.foreground} />
      </Pressable>
    </View>
  );

  const previewImage = previewQuery.isPending ? (
    <ActivityIndicator color={theme.colors.accent} />
  ) : previewQuery.isError || previewQuery.data?.error || !dataUri ? (
    <Text style={styles.error}>
      {previewQuery.data?.error ??
        (previewQuery.error instanceof Error ? previewQuery.error.message : "Preview unavailable.")}
    </Text>
  ) : null;

  const previewActions = (
    <View style={styles.actions}>
      <Pressable
        accessibilityRole="button"
        disabled={downloading}
        style={[styles.button, styles.primaryButton]}
        onPress={download}
      >
        {downloading ? (
          <ActivityIndicator color={theme.colors.accentForeground} />
        ) : (
          <Icon name="Download" size={14} color={theme.colors.accentForeground} />
        )}
        <Text style={[styles.buttonLabel, styles.primaryLabel]}>
          {downloading ? `Saving ${Math.round(progress * 100)}%` : "Download"}
        </Text>
      </Pressable>
      <Pressable accessibilityRole="button" style={styles.button} onPress={() => copy(activeFilePath, "Path")}>
        <Icon name="Copy" size={14} color={theme.colors.foreground} />
        <Text style={styles.buttonLabel}>Copy path</Text>
      </Pressable>
    </View>
  );

  return (
    <View onLayout={onLayout}>
      <View style={styles.caption}>
        <Text style={styles.name} numberOfLines={1}>
          {fileName}
        </Text>
        {sizeLabel ? <Text style={styles.meta}>{sizeLabel}</Text> : null}
      </View>
      {body}
      {isWeb ? (
        <RNModal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
          <View style={styles.webOverlay}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close preview"
              style={StyleSheet.absoluteFillObject}
              onPress={() => setOpen(false)}
            />
            <View style={styles.webCard}>
              <View style={styles.webHeader}>
                <View style={styles.webTitleGroup}>
                  <Icon name="Image" size={16} color={theme.colors.foreground} />
                  <Text style={styles.webTitle} numberOfLines={1}>
                    {fileName}
                  </Text>
                </View>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Close"
                  style={styles.closeButton}
                  onPress={() => setOpen(false)}
                >
                  <Icon name="X" size={16} color={theme.colors.foreground} />
                </Pressable>
              </View>
              {dataUri && fullscreenImageStyle ? (
                <Image source={{ uri: dataUri }} style={fullscreenImageStyle} accessibilityLabel={activeFileName} />
              ) : previewImage}
              {navigation}
              <Text style={styles.path}>{activeFilePath}</Text>
              {previewActions}
            </View>
          </View>
        </RNModal>
      ) : (
        <Modal
          title={activeFileName}
          icon={<Icon name="Image" size={16} color={theme.colors.foreground} />}
          open={open}
          onOpenChange={setOpen}
        >
          <Modal.Content>
            <View onLayout={onModalLayout}>
              {dataUri && modalImageStyle ? (
                <Image source={{ uri: dataUri }} style={modalImageStyle} accessibilityLabel={activeFileName} />
              ) : previewImage}
            </View>
            {navigation}
            <Text style={styles.path}>{activeFilePath}</Text>
            {previewActions}
          </Modal.Content>
        </Modal>
      )}
    </View>
  );
}
