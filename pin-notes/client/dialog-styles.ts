import type { PluginSidebarItemProps } from "@getpaseo/plugin/client";

export type Theme = PluginSidebarItemProps["theme"];

export function dialogStyles(theme: Theme) {
  const { colors } = theme;
  return {
    body: { padding: 20, gap: 20 },
    composer: {
      gap: 10,
      padding: 14,
      borderRadius: 16,
      backgroundColor: colors.surface1,
      borderWidth: 1,
      borderColor: colors.border,
    },
    titleInput: {
      color: colors.foreground,
      fontSize: 15,
      fontWeight: "600" as const,
      paddingVertical: 2,
    },
    bodyInput: {
      color: colors.foreground,
      fontSize: 14,
      lineHeight: 20,
      minHeight: 40,
      paddingVertical: 2,
      textAlignVertical: "top" as const,
    },
    composerFooter: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      justifyContent: "space-between" as const,
      gap: 12,
    },
    hint: { color: colors.foregroundMuted, fontSize: 12, flex: 1 },
    error: { color: colors.statusDanger, fontSize: 12, flex: 1 },
    pinButton: {
      paddingHorizontal: 16,
      paddingVertical: 8,
      borderRadius: 999,
      backgroundColor: colors.foreground,
    },
    pinButtonText: { color: colors.surface0, fontSize: 13, fontWeight: "600" as const },
    sectionLabel: {
      color: colors.foregroundMuted,
      fontSize: 12,
      fontWeight: "600" as const,
      letterSpacing: 0.4,
      textTransform: "uppercase" as const,
    },
    list: { gap: 6 },
    row: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 12,
      paddingVertical: 10,
      paddingLeft: 12,
      paddingRight: 8,
      borderRadius: 12,
    },
    rowPressed: { backgroundColor: colors.surface1 },
    glyph: {
      width: 32,
      height: 32,
      borderRadius: 8,
      alignItems: "center" as const,
      justifyContent: "center" as const,
      backgroundColor: colors.surface2,
    },
    rowText: { flex: 1, gap: 2 },
    rowTitle: { color: colors.foreground, fontSize: 14, fontWeight: "600" as const },
    rowSubtitle: { color: colors.foregroundMuted, fontSize: 12 },
    remove: {
      width: 28,
      height: 28,
      borderRadius: 14,
      alignItems: "center" as const,
      justifyContent: "center" as const,
    },
    empty: {
      color: colors.foregroundMuted,
      fontSize: 13,
      textAlign: "center" as const,
      paddingVertical: 16,
    },
  };
}
