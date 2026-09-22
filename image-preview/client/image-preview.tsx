import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
// Icon resolves names with Reflect.get() against the lucide module, so `name`
// must be the exported symbol (PascalCase, e.g. "Download") - not the kebab-case
// name from the Lucide website. An unknown name renders nothing, silently.
import { Icon, Modal, copyText, useToast } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useCallback, useMemo, useState } from "react";
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
import { loadImageRpc, readChunkRpc } from "../shared/image";
import { base64ToBytes, canSaveFile, saveFile } from "./download";

const FETCH_MAX_WIDTH = 1024;

export function ImagePreviewItem({
  theme,
  layout,
  item,
}: PluginTimelineItemProps<ImagePreviewData>) {
  const { filePath, fileName, status } = item.data;
  const [open, setOpen] = useState(false);
  const [decodeFailed, setDecodeFailed] = useState(false);
  const [boxWidth, setBoxWidth] = useState(0);
  const [modalBoxWidth, setModalBoxWidth] = useState(0);
  const loadImage = useRpc(loadImageRpc);
  const readChunk = useRpc(readChunkRpc);
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
    }),
    [theme, layout.compact],
  );

  const aspectRatio =
    query.data?.width && query.data?.height ? query.data.width / query.data.height : undefined;

  // Fit the box to the image instead of the image to the box, so there is never
  // any letterboxed dead space around it. Width is measured rather than assumed
  // because a percentage width cannot be capped by height in Yoga.
  const inlineImageStyle = useMemo(() => {
    if (!aspectRatio || boxWidth <= 0) return undefined;
    const width = Math.min(boxWidth, maxInlineHeight * aspectRatio);
    return {
      width,
      aspectRatio,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: theme.colors.border,
    };
  }, [aspectRatio, boxWidth, maxInlineHeight, theme.colors.border]);

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
      readChunk({ filePath, offset }).then((result) => {
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
          saveFile(parts, fileName, result.mimeType ?? "application/octet-stream");
          return;
        }
        return pump(received);
      });

    pump(0)
      .then(() => toast.show(`${fileName} saved`, { variant: "success" }))
      .catch((error: unknown) => {
        toast.error(error instanceof Error ? error.message : "Download failed");
      })
      .finally(() => setDownloading(false));
  }, [downloading, fileName, filePath, readChunk, toast]);

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
        onPress={() => setOpen(true)}
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

  const dataUri = query.data?.dataUri ?? null;

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
      <Pressable accessibilityRole="button" style={styles.button} onPress={() => copy(filePath, "Path")}>
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
                <Image source={{ uri: dataUri }} style={fullscreenImageStyle} accessibilityLabel={fileName} />
              ) : null}
              <Text style={styles.path}>{filePath}</Text>
              {previewActions}
            </View>
          </View>
        </RNModal>
      ) : (
        <Modal
          title={fileName}
          icon={<Icon name="Image" size={16} color={theme.colors.foreground} />}
          open={open}
          onOpenChange={setOpen}
        >
          <Modal.Content>
            <View onLayout={onModalLayout}>
              {dataUri && modalImageStyle ? (
                <Image source={{ uri: dataUri }} style={modalImageStyle} accessibilityLabel={fileName} />
              ) : null}
            </View>
            <Text style={styles.path}>{filePath}</Text>
            {previewActions}
          </Modal.Content>
        </Modal>
      )}
    </View>
  );
}
