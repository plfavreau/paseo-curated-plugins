import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
// Icon names are the exported Lucide symbols (PascalCase). Unknown names render nothing.
import { Icon, Modal, copyText, useToast } from "@getpaseo/plugin/client/ui";
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
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import type { PdfPreviewData } from "../shared/pdf";
import { readChunkRpc, renderPageRpc } from "../shared/pdf";
import { canOpenInBrowser, canSaveFile, openInBrowser, saveFile } from "./download";
import { readOriginal } from "./original";

const THUMB_WIDTH = 640;
const VIEWER_WIDTH = 1400;
const PAGE_ASPECT_FALLBACK = 612 / 792;

export function PdfPreviewItem({ theme, layout, item }: PluginTimelineItemProps<PdfPreviewData>) {
  const { filePath, fileName, status, command, output, exitCode } = item.data;
  const fromShell = command !== undefined;
  const isWeb = Platform.OS === "web";
  const window = useWindowDimensions();
  const toast = useToast();
  const renderPage = useRpc(renderPageRpc);
  const readChunk = useRpc(readChunkRpc);

  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [showOutput, setShowOutput] = useState(false);
  const [boxWidth, setBoxWidth] = useState(0);
  const [busy, setBusy] = useState<null | "download" | "open">(null);
  const [progress, setProgress] = useState(0);

  // A shell command may only name a PDF it is about to create, so wait for it to finish.
  const ready = status === "completed" || (fromShell && status === "failed");

  const thumb = useQuery({
    queryKey: ["pdf-preview", filePath, 1, THUMB_WIDTH],
    queryFn: () => renderPage({ filePath, page: 1, maxWidth: THUMB_WIDTH }),
    enabled: ready,
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
  const pageCount = thumb.data?.pageCount ?? null;

  const viewer = useQuery({
    queryKey: ["pdf-preview", filePath, page, VIEWER_WIDTH],
    queryFn: () => renderPage({ filePath, page, maxWidth: VIEWER_WIDTH }),
    enabled: open && ready,
    staleTime: 5 * 60 * 1000,
    retry: false,
    placeholderData: (previous) => previous,
  });

  const goTo = useCallback(
    (direction: -1 | 1) => {
      setPage((current) => {
        const next = current + direction;
        if (next < 1 || (pageCount !== null && next > pageCount)) return current;
        return next;
      });
    },
    [pageCount],
  );

  useEffect(() => {
    if (!open || !isWeb) return;
    const target = globalThis as unknown as {
      addEventListener(type: "keydown", listener: (event: KeyEvent) => void, capture: boolean): void;
      removeEventListener(type: "keydown", listener: (event: KeyEvent) => void, capture: boolean): void;
    };
    const onKeyDown = (event: KeyEvent) => {
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        event.stopPropagation();
        goTo(event.key === "ArrowLeft" ? -1 : 1);
      } else if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
      }
    };
    target.addEventListener("keydown", onKeyDown, true);
    return () => target.removeEventListener("keydown", onKeyDown, true);
  }, [open, isWeb, goTo]);

  const styles = useMemo(
    () => ({
      caption: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6, paddingBottom: 4 },
      name: {
        color: theme.colors.foregroundMuted,
        fontSize: layout.compact ? 11 : 12,
        fontWeight: "500" as const,
        flexShrink: 1,
      },
      meta: { color: theme.colors.foregroundMuted, fontSize: layout.compact ? 11 : 12 },
      error: { color: theme.colors.statusDanger, fontSize: 12 },
      statusRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8, paddingVertical: 6 },
      commandRow: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 6,
        paddingVertical: 4,
      },
      command: {
        color: theme.colors.foregroundMuted,
        fontFamily: Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" }),
        fontSize: 12,
        flexShrink: 1,
      },
      output: {
        maxHeight: 220,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
        padding: 8,
        marginBottom: 6,
      },
      outputText: {
        color: theme.colors.foreground,
        fontFamily: Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" }),
        fontSize: 11,
      },
      thumb: { borderRadius: 6, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: "#ffffff" },
      actions: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8 },
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
      primaryButton: { borderColor: theme.colors.accent, backgroundColor: theme.colors.accent },
      buttonLabel: { color: theme.colors.foreground, fontSize: 13, fontWeight: "500" as const },
      primaryLabel: { color: theme.colors.accentForeground },
      path: { color: theme.colors.foregroundMuted, fontSize: 11 },
      overlay: {
        flex: 1,
        alignItems: "center" as const,
        justifyContent: "center" as const,
        backgroundColor: "rgba(0, 0, 0, 0.72)",
      },
      card: {
        maxWidth: "94%" as const,
        maxHeight: "94%" as const,
        alignItems: "stretch" as const,
        gap: 12,
        backgroundColor: theme.colors.surface2,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 14,
        padding: 16,
      },
      header: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "space-between" as const,
        gap: 12,
      },
      titleGroup: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8, flexShrink: 1 },
      title: { color: theme.colors.foreground, fontSize: 14, fontWeight: "600" as const, flexShrink: 1 },
      iconButton: { padding: 6, borderRadius: 6 },
      navigation: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "center" as const,
        gap: 16,
      },
      navButton: { padding: 10, borderRadius: 8, backgroundColor: theme.colors.surface1 },
      placeholder: {
        alignItems: "center" as const,
        justifyContent: "center" as const,
        backgroundColor: theme.colors.surface1,
        borderRadius: 8,
      },
    }),
    [theme, layout.compact],
  );

  const thumbAspect =
    thumb.data?.width && thumb.data?.height ? thumb.data.width / thumb.data.height : PAGE_ASPECT_FALLBACK;
  const maxThumbHeight = layout.compact ? 240 : 280;
  const thumbStyle = useMemo(() => {
    if (boxWidth <= 0) return undefined;
    const width = Math.min(boxWidth, maxThumbHeight * thumbAspect, layout.compact ? 200 : 240);
    return { width, aspectRatio: thumbAspect };
  }, [boxWidth, maxThumbHeight, thumbAspect, layout.compact]);

  const viewerAspect =
    viewer.data?.width && viewer.data?.height ? viewer.data.width / viewer.data.height : thumbAspect;
  const viewerStyle = useMemo(() => {
    const maxHeight = window.height * (isWeb ? 0.74 : 0.6);
    const maxWidth = window.width * (isWeb ? 0.86 : 0.82);
    const width = Math.min(maxWidth, maxHeight * viewerAspect);
    return { width, aspectRatio: viewerAspect, alignSelf: "center" as const, borderRadius: 6 };
  }, [window.width, window.height, viewerAspect, isWeb]);

  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const next = event.nativeEvent.layout.width;
    setBoxWidth((previous) => (previous === next ? previous : next));
  }, []);

  const fetchOriginal = useCallback(
    (mode: "download" | "open") => {
      if (busy) return;
      if (mode === "download" ? !canSaveFile() : !canOpenInBrowser()) {
        toast.error("This is only supported in the Paseo web and desktop app.");
        return;
      }
      setBusy(mode);
      setProgress(0);
      readOriginal(readChunk, filePath, setProgress)
        .then(({ parts, mimeType }) => {
          if (mode === "download") {
            saveFile(parts, fileName, mimeType);
            toast.show(`${fileName} saved`, { variant: "success" });
          } else {
            openInBrowser(parts, mimeType);
          }
        })
        .catch((error: unknown) => toast.error(error instanceof Error ? error.message : "Failed to read the PDF"))
        .finally(() => setBusy(null));
    },
    [busy, readChunk, filePath, fileName, toast],
  );

  const copyPath = useCallback(() => {
    copyText(filePath).then(
      () => toast.show("Path copied", { variant: "success" }),
      (error: unknown) => toast.error(error instanceof Error ? error.message : "Copy failed"),
    );
  }, [filePath, toast]);

  const commandHeader = fromShell ? (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={showOutput ? "Hide command output" : "Show command output"}
        style={styles.commandRow}
        onPress={() => setShowOutput((value) => !value)}
      >
        <Icon name="SquareTerminal" size={13} color={theme.colors.foregroundMuted} />
        <Text style={styles.command} numberOfLines={showOutput ? undefined : 1}>
          {command}
        </Text>
        {exitCode !== null && exitCode !== undefined && exitCode !== 0 ? (
          <Text style={styles.error}>exit {exitCode}</Text>
        ) : null}
        <Icon name={showOutput ? "ChevronUp" : "ChevronDown"} size={13} color={theme.colors.foregroundMuted} />
      </Pressable>
      {showOutput ? (
        <ScrollView style={styles.output} nestedScrollEnabled>
          <Text style={styles.outputText} selectable>
            {output && output.length > 0 ? output : "(no output)"}
          </Text>
        </ScrollView>
      ) : null}
    </>
  ) : null;

  let body: ReactNode;
  if (status === "running") {
    body = (
      <View style={styles.statusRow}>
        <ActivityIndicator color={theme.colors.accent} />
        <Text style={styles.meta}>{fromShell ? "Running…" : `Reading ${fileName}…`}</Text>
      </View>
    );
  } else if (!ready) {
    body = (
      <View style={styles.statusRow}>
        <Text style={styles.meta}>
          {fromShell ? "Command" : "Read"} {status}: {fileName}
        </Text>
      </View>
    );
  } else if (thumb.isPending) {
    body = (
      <View style={styles.statusRow}>
        <ActivityIndicator color={theme.colors.accent} />
        <Text style={styles.meta}>Rendering {fileName}…</Text>
      </View>
    );
  } else if (thumb.isError || thumb.data?.error || !thumb.data?.dataUri) {
    const message =
      thumb.data?.error ?? (thumb.error instanceof Error ? thumb.error.message : "Preview unavailable.");
    // A path in a shell command can be a false positive (a file never created), so stay quiet about it.
    body = (
      <View style={styles.statusRow}>
        <Text style={fromShell ? styles.meta : styles.error}>
          {fromShell ? `No preview for ${fileName}: ${message}` : message}
        </Text>
      </View>
    );
  } else {
    body = (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Open ${fileName}`}
        onPress={() => {
          setPage(1);
          setOpen(true);
        }}
      >
        {thumbStyle ? (
          <Image source={{ uri: thumb.data.dataUri }} style={[styles.thumb, thumbStyle]} accessibilityLabel={fileName} />
        ) : null}
      </Pressable>
    );
  }

  const showCaption = !fromShell || (ready && Boolean(thumb.data?.dataUri));

  const pageImage = viewer.data?.dataUri ? (
    <Image source={{ uri: viewer.data.dataUri }} style={[viewerStyle, { backgroundColor: "#ffffff" }]} accessibilityLabel={`${fileName} page ${page}`} />
  ) : (
    <View style={[styles.placeholder, viewerStyle]}>
      {viewer.isPending || viewer.isFetching ? (
        <ActivityIndicator color={theme.colors.accent} />
      ) : (
        <Text style={styles.error}>
          {viewer.data?.error ?? (viewer.error instanceof Error ? viewer.error.message : "Page unavailable.")}
        </Text>
      )}
    </View>
  );

  const navigation = (
    <View style={styles.navigation}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Previous page"
        disabled={page <= 1}
        style={[styles.navButton, { opacity: page > 1 ? 1 : 0.4 }]}
        onPress={() => goTo(-1)}
      >
        <Icon name="ChevronLeft" size={20} color={theme.colors.foreground} />
      </Pressable>
      <Text style={styles.meta}>
        Page {page}
        {pageCount ? ` of ${pageCount}` : ""}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Next page"
        disabled={pageCount !== null && page >= pageCount}
        style={[styles.navButton, { opacity: pageCount === null || page < pageCount ? 1 : 0.4 }]}
        onPress={() => goTo(1)}
      >
        <Icon name="ChevronRight" size={20} color={theme.colors.foreground} />
      </Pressable>
    </View>
  );

  const actions = (
    <View style={styles.actions}>
      {isWeb ? (
        <Pressable
          accessibilityRole="button"
          disabled={busy !== null}
          style={[styles.button, styles.primaryButton]}
          onPress={() => fetchOriginal("open")}
        >
          {busy === "open" ? (
            <ActivityIndicator color={theme.colors.accentForeground} />
          ) : (
            <Icon name="ExternalLink" size={14} color={theme.colors.accentForeground} />
          )}
          <Text style={[styles.buttonLabel, styles.primaryLabel]}>
            {busy === "open" ? `Loading ${Math.round(progress * 100)}%` : "Open full PDF"}
          </Text>
        </Pressable>
      ) : null}
      <Pressable
        accessibilityRole="button"
        disabled={busy !== null}
        style={styles.button}
        onPress={() => fetchOriginal("download")}
      >
        {busy === "download" ? (
          <ActivityIndicator color={theme.colors.foreground} />
        ) : (
          <Icon name="Download" size={14} color={theme.colors.foreground} />
        )}
        <Text style={styles.buttonLabel}>
          {busy === "download" ? `Saving ${Math.round(progress * 100)}%` : "Download"}
        </Text>
      </Pressable>
      <Pressable accessibilityRole="button" style={styles.button} onPress={copyPath}>
        <Icon name="Copy" size={14} color={theme.colors.foreground} />
        <Text style={styles.buttonLabel}>Copy path</Text>
      </Pressable>
    </View>
  );

  return (
    <View onLayout={onLayout}>
      {commandHeader}
      {showCaption ? (
        <View style={styles.caption}>
          <Icon name="FileText" size={13} color={theme.colors.foregroundMuted} />
          <Text style={styles.name} numberOfLines={1}>
            {fileName}
          </Text>
          {pageCount ? (
            <Text style={styles.meta}>
              {pageCount} page{pageCount === 1 ? "" : "s"}
            </Text>
          ) : null}
        </View>
      ) : null}
      {body}
      {isWeb ? (
        <RNModal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
          <View style={styles.overlay}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close preview"
              style={StyleSheet.absoluteFillObject}
              onPress={() => setOpen(false)}
            />
            <View style={styles.card}>
              <View style={styles.header}>
                <View style={styles.titleGroup}>
                  <Icon name="FileText" size={16} color={theme.colors.foreground} />
                  <Text style={styles.title} numberOfLines={1}>
                    {fileName}
                  </Text>
                </View>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Close"
                  style={styles.iconButton}
                  onPress={() => setOpen(false)}
                >
                  <Icon name="X" size={16} color={theme.colors.foreground} />
                </Pressable>
              </View>
              {pageImage}
              {navigation}
              <Text style={styles.path}>{filePath}</Text>
              {actions}
            </View>
          </View>
        </RNModal>
      ) : (
        <Modal
          title={fileName}
          icon={<Icon name="FileText" size={16} color={theme.colors.foreground} />}
          open={open}
          onOpenChange={setOpen}
        >
          <Modal.Content>
            {pageImage}
            {navigation}
            <Text style={styles.path}>{filePath}</Text>
            {actions}
          </Modal.Content>
        </Modal>
      )}
    </View>
  );
}

interface KeyEvent {
  key: string;
  preventDefault(): void;
  stopPropagation(): void;
}
