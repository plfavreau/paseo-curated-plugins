import type { PluginClientContext } from "@getpaseo/plugin/client";
import { ImagePreviewItem } from "./client/image-preview";
import {
  IMAGE_PREVIEW_KIND,
  IMAGE_PREVIEW_VERSION,
  basename,
  imagePreviewSchema,
  isPreviewableImage,
} from "./shared/image";

export default function contribute(client: PluginClientContext) {
  const cleanups = [
    client.addTimelineTransformer({
      id: "image-preview-read-images",
      query: { itemType: "tool_call" },
      transform({ item }) {
        const detail = item.detail;
        if (detail.type !== "read") return undefined;
        const filePath = detail.filePath;
        if (typeof filePath !== "string" || !isPreviewableImage(filePath)) return undefined;

        return {
          items: [
            {
              type: "plugin" as const,
              kind: IMAGE_PREVIEW_KIND,
              version: IMAGE_PREVIEW_VERSION,
              data: {
                filePath,
                fileName: basename(filePath),
                status: item.status,
                callId: item.callId,
              },
            },
          ],
        };
      },
    }),
    client.addTimelineRenderer({
      kind: IMAGE_PREVIEW_KIND,
      version: IMAGE_PREVIEW_VERSION,
      schema: imagePreviewSchema,
      Component: ImagePreviewItem,
    }),
  ];

  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}
