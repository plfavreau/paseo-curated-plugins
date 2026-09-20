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
import { ActivityIndicator, Image, Linking, Pressable, Text, View } from "react-native";
import type { ImagePreviewData } from "../shared/image";
import { SHARE_EXPIRY_HOURS, loadImageRpc, shareImageRpc } from "../shared/image";

const FETCH_MAX_WIDTH = 1024;

/**
 * `react-native` is passed through to plugin code by the host, but the exact
 * surface is not part of the plugin contract, so never assume Linking exists.
 */
function openExternal(url: string): Promise<unknown> {
  const linking = Linking as typeof Linking | undefined;
  if (!linking || typeof linking.openURL !== "function") {
    return Promise.reject(new Error("no-linking"));
  }
  return linking.openURL(url);
}

export function ImagePreviewItem({
  theme,
  layout,
  item,
}: PluginTimelineItemProps<ImagePreviewData>) {
  const { filePath, fileName, status } = item.data;
  const [open, setOpen] = useState(false);
  const [decodeFailed, setDecodeFailed] = useState(false);
  const [boxWidth, setBoxWidth] = useState(0);
  const loadImage = useRpc(loadImageRpc);
  const shareImage = useRpc(shareImageRpc);
  const toast = useToast();
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);

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
      link: {
        color: theme.colors.accent,
        fontSize: 12,
        textDecorationLine: "underline" as const,
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

  const download = useCallback(() => {
    if (sharing) return;
    if (shareUrl) {
      openExternal(shareUrl).catch(() => toast.show("Use the link below", { variant: "info" }));
      return;
    }
    setSharing(true);
    shareImage({ filePath })
      .then((result) => {
        if (result.error || !result.url) {
          toast.error(result.error ?? "Could not create a download link.");
          return;
        }
        const url = `${result.url}?dl=1`;
        setShareUrl(url);
        // The browser may block a popup opened outside a direct gesture, so a
        // tappable link is always rendered as a fallback.
        openExternal(url).catch(() => toast.show("Use the link below", { variant: "info" }));
      })
      .catch((error: unknown) => {
        toast.error(error instanceof Error ? error.message : "Download failed");
      })
      .finally(() => setSharing(false));
  }, [filePath, shareImage, shareUrl, sharing, toast]);

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

  return (
    <View onLayout={onLayout}>
      <View style={styles.caption}>
        <Text style={styles.name} numberOfLines={1}>
          {fileName}
        </Text>
        {sizeLabel ? <Text style={styles.meta}>{sizeLabel}</Text> : null}
      </View>
      {body}
      <Modal
        title={fileName}
        icon={<Icon name="Image" size={16} color={theme.colors.foreground} />}
        open={open}
        onOpenChange={setOpen}
      >
        <Modal.Content>
          {dataUri && aspectRatio ? (
            <Image
              source={{ uri: dataUri }}
              style={{ width: "100%", aspectRatio, borderRadius: 8 }}
              accessibilityLabel={fileName}
            />
          ) : null}
          <Text style={styles.path}>{filePath}</Text>
          <View style={styles.actions}>
            <Pressable
              accessibilityRole="button"
              disabled={sharing}
              style={[styles.button, styles.primaryButton]}
              onPress={download}
            >
              {sharing ? (
                <ActivityIndicator color={theme.colors.accentForeground} />
              ) : (
                <Icon name="Download" size={14} color={theme.colors.accentForeground} />
              )}
              <Text style={[styles.buttonLabel, styles.primaryLabel]}>
                {sharing ? "Preparing…" : "Download"}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              style={styles.button}
              onPress={() => copy(shareUrl ?? filePath, shareUrl ? "Link" : "Path")}
            >
              <Icon
                name={shareUrl ? "Link" : "Copy"}
                size={14}
                color={theme.colors.foreground}
              />
              <Text style={styles.buttonLabel}>{shareUrl ? "Copy link" : "Copy path"}</Text>
            </Pressable>
          </View>
          {shareUrl ? (
            <Pressable accessibilityRole="link" onPress={() => download()}>
              <Text style={styles.link} numberOfLines={2}>
                {shareUrl}
              </Text>
              <Text style={styles.path}>Expires in {SHARE_EXPIRY_HOURS}h · anyone with the link</Text>
            </Pressable>
          ) : null}
        </Modal.Content>
      </Modal>
    </View>
  );
}
