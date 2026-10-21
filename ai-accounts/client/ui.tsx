import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { Children, createContext, Fragment, isValidElement, type ReactNode, type RefObject, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { TextStyle, ViewStyle } from "react-native";
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View } from "react-native";

export type Theme = PluginScreenProps["theme"];

export const CLICKABLE = { cursor: "pointer" } as ViewStyle;
export const TABULAR = { fontVariant: ["tabular-nums"] } as TextStyle;

export function useUi(theme: Theme, dense = false) {
  return useMemo(() => {
    const c = theme.colors;
    return StyleSheet.create({
      pageTitle: { color: c.foreground, fontSize: dense ? 17 : 28, lineHeight: dense ? 22 : 34, fontWeight: "700", letterSpacing: dense ? -0.3 : -0.9 },
      pageSubtitle: { color: c.foregroundMuted, fontSize: 13.5, lineHeight: 20, maxWidth: 560 },
      sectionHead: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 2, minHeight: 28 },
      sectionTitle: { color: c.foreground, fontSize: dense ? 13.5 : 15, fontWeight: "600", letterSpacing: -0.2 },
      label: { color: c.foregroundMuted, fontSize: 12, fontWeight: "500" },
      group: { borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: c.border },
      row: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: dense ? 10 : 13, paddingHorizontal: 2, minHeight: dense ? 46 : 54 },
      separator: { height: StyleSheet.hairlineWidth, backgroundColor: c.border },
      primary: { color: c.foreground, fontSize: 13.5, fontWeight: "500", letterSpacing: -0.1 },
      secondary: { color: c.foregroundMuted, fontSize: 12, lineHeight: 16 },
      footnote: { color: c.foregroundMuted, fontSize: 11.5, lineHeight: 16, paddingHorizontal: 2 },
      danger: { color: c.statusDanger, fontSize: 12, lineHeight: 16 },
      track: { height: 3, borderRadius: 2, backgroundColor: c.surface2, overflow: "hidden" },
      fill: { height: 3, borderRadius: 2 },
      disabled: { opacity: 0.4 },
    });
  }, [theme, dense]);
}

/** An inset grouped list: one rounded container, hairlines between rows, no card per item. */
export function Group({ theme, dense, children, style }: { theme: Theme; dense?: boolean; children: ReactNode; style?: ViewStyle }) {
  const ui = useUi(theme, dense);
  const rows = Children.toArray(children).filter((child) => isValidElement(child));
  return (
    <View style={[ui.group, style]}>
      {rows.map((row, index) => (
        <Fragment key={isValidElement(row) && row.key != null ? row.key : index}>
          {index > 0 ? <View style={ui.separator} /> : null}
          {row}
        </Fragment>
      ))}
    </View>
  );
}

export function SectionHead({ theme, dense, title, leading, children }: { theme: Theme; dense?: boolean; title: string; leading?: ReactNode; children?: ReactNode }) {
  const ui = useUi(theme, dense);
  return (
    <View style={ui.sectionHead}>
      {leading}
      <Text style={ui.sectionTitle}>{title}</Text>
      <View style={{ flex: 1 }} />
      {children}
    </View>
  );
}

type ButtonKind = "primary" | "secondary" | "plain" | "destructive";

export function Button({
  theme,
  kind = "secondary",
  title,
  onPress,
  disabled,
  loading,
  accessibilityLabel,
  color,
}: {
  theme: Theme;
  kind?: ButtonKind;
  title: string;
  onPress(): void;
  disabled?: boolean;
  loading?: boolean;
  accessibilityLabel?: string;
  color?: string;
}) {
  const c = theme.colors;
  const filled = kind === "primary" || kind === "secondary";
  const background = kind === "primary" ? c.foreground : kind === "secondary" ? c.surface2 : "transparent";
  const foreground = kind === "primary" ? c.surface0 : kind === "destructive" ? c.statusDanger : kind === "plain" ? (color ?? c.foreground) : c.foreground;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        { flexDirection: "row", alignItems: "center", gap: 6, borderRadius: 8, backgroundColor: background },
        filled ? { paddingVertical: 6, paddingHorizontal: 12 } : { paddingVertical: 4, paddingHorizontal: 2 },
        CLICKABLE,
        disabled ? { opacity: 0.4 } : pressed ? { opacity: 0.7 } : null,
      ]}
    >
      {loading ? <ActivityIndicator color={foreground} size="small" /> : null}
      <Text style={{ color: foreground, fontSize: 13, fontWeight: kind === "primary" ? "600" : "500", letterSpacing: -0.1 }}>{title}</Text>
    </Pressable>
  );
}

/** Small coloured word, no box: a status reads as text, not as a badge competing with content. */
export function Tag({ color, children }: { color: string; children: string }) {
  return <Text style={{ color, fontSize: 11.5, fontWeight: "600", letterSpacing: -0.05 }}>{children}</Text>;
}

export function Meter({ theme, value, color, marker }: { theme: Theme; value: number; color: string; marker?: number }) {
  const ui = useUi(theme);
  const clamp = (n: number) => Math.min(100, Math.max(0, n * 100));
  return (
    <View style={[ui.track, marker !== undefined ? { overflow: "visible" } : null]}>
      <View style={[ui.fill, { width: `${clamp(value)}%`, backgroundColor: color }]} />
      {marker !== undefined && marker > 0 ? (
        <View style={{ position: "absolute", top: -3, left: `${Math.min(99.4, clamp(marker))}%`, width: 1.5, height: 9, borderRadius: 1, backgroundColor: theme.colors.foreground, opacity: 0.7 }} />
      ) : null}
    </View>
  );
}

export function Dot({ color, size = 7, hollow = false }: { color: string; size?: number; hollow?: boolean }) {
  return <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: hollow ? "transparent" : color, borderWidth: hollow ? 1.5 : 0, borderColor: color }} />;
}

export function Chevron({ theme, open }: { theme: Theme; open: boolean }) {
  return <Text style={{ color: theme.colors.foregroundMuted, fontSize: 15, lineHeight: 16, transform: [{ rotate: open ? "90deg" : "0deg" }] }}>›</Text>;
}

export function Check({ color }: { color: string }) {
  return <Text style={{ color, fontSize: 13, fontWeight: "600", lineHeight: 16 }}>✓</Text>;
}

type LayerStore = {
  owner: symbol | null;
  node: ReactNode;
  listeners: Set<() => void>;
  root: RefObject<View | null>;
  show(owner: symbol, node: ReactNode): void;
  hide(owner: symbol): void;
};

const LayerContext = createContext<LayerStore | null>(null);

function createLayerStore(root: RefObject<View | null>): LayerStore {
  const store: LayerStore = {
    owner: null,
    node: null,
    listeners: new Set(),
    root,
    show(owner, node) {
      store.owner = owner;
      store.node = node;
      for (const listener of store.listeners) listener();
    },
    hide(owner) {
      if (store.owner !== owner) return;
      store.owner = null;
      store.node = null;
      for (const listener of store.listeners) listener();
    },
  };
  return store;
}

function LayerSlot({ store }: { store: LayerStore }) {
  const node = useSyncExternalStore(
    (listener) => {
      store.listeners.add(listener);
      return () => store.listeners.delete(listener);
    },
    () => store.node,
  );
  return node ? <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>{node}</View> : null;
}

/**
 * Hosts dropdowns in-tree. Inside a Paseo popover a React Native Modal fights the popover's
 * focus trap and freezes the app, so floating content must stay inside the popover's DOM.
 */
export function FloatingLayer({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  const root = useRef<View>(null);
  const [store] = useState(() => createLayerStore(root));
  return (
    <LayerContext.Provider value={store}>
      <View ref={root} style={[{ position: "relative" }, style]}>
        {children}
        <LayerSlot store={store} />
      </View>
    </LayerContext.Provider>
  );
}

type Frame = { x: number; y: number; w: number; h: number; layerW: number; layerH: number };

/** A floating menu anchored to its trigger, layered above the page so it never reflows it. */
export function Dropdown({
  theme,
  accessibilityLabel,
  renderTrigger,
  children,
  width = 240,
  maxHeight = 380,
  header,
  onClose,
}: {
  theme: Theme;
  maxHeight?: number;
  header?: ReactNode;
  onClose?(): void;
  accessibilityLabel: string;
  renderTrigger(open: boolean, pressed: boolean): ReactNode;
  children(close: () => void): ReactNode;
  width?: number;
}) {
  const layer = useContext(LayerContext);
  const [owner] = useState(() => Symbol("dropdown"));
  const anchor = useRef<View>(null);
  const window = useWindowDimensions();
  const [frame, setFrame] = useState<Frame | null>(null);
  const close = () => {
    setFrame(null);
    onClose?.();
  };
  const open = () =>
    anchor.current?.measureInWindow((x, y, w, h) => {
      const root = layer?.root.current;
      if (!root) return setFrame({ x, y, w, h, layerW: window.width, layerH: window.height });
      root.measureInWindow((lx, ly, lw, lh) => setFrame({ x: x - lx, y: y - ly, w, h, layerW: lw, layerH: lh }));
    });
  const c = theme.colors;

  let panel: ReactNode = null;
  if (frame) {
    const below = frame.y + frame.h + 6;
    const flipUp = !layer && below + Math.min(maxHeight, 320) > frame.layerH && frame.y > frame.layerH / 2;
    const room = layer ? maxHeight : flipUp ? frame.y - 14 : frame.layerH - below - 8;
    panel = (
      <>
        <Pressable accessibilityLabel="Close menu" onPress={close} style={[StyleSheet.absoluteFill, { cursor: "auto" } as ViewStyle]} />
        <View
          style={[
            {
              position: "absolute",
              right: Math.max(layer ? 4 : 8, frame.layerW - (frame.x + frame.w)),
              width: Math.min(width, frame.layerW - 8),
              maxHeight: Math.min(maxHeight, room),
              paddingVertical: 5,
              borderRadius: 12,
              borderWidth: StyleSheet.hairlineWidth,
              borderColor: c.border,
              backgroundColor: c.surface1,
              shadowColor: "#000",
              shadowOpacity: 0.18,
              shadowRadius: 24,
              shadowOffset: { width: 0, height: 8 },
              elevation: 12,
            },
            flipUp ? { bottom: frame.layerH - frame.y + 6 } : { top: below },
          ]}
        >
          {header}
          <ScrollView bounces={false} keyboardShouldPersistTaps="handled" style={{ flexShrink: 1 }}>
            {children(close)}
          </ScrollView>
        </View>
      </>
    );
  }

  useLayoutEffect(() => {
    if (!layer) return;
    if (panel) layer.show(owner, panel);
    else layer.hide(owner);
  });
  useEffect(() => () => layer?.hide(owner), [layer, owner]);

  return (
    <>
      <Pressable
        ref={anchor}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityState={{ expanded: frame !== null }}
        onPress={(event) => {
          event.stopPropagation();
          if (frame) close();
          else open();
        }}
        style={CLICKABLE}
      >
        {({ pressed }) => renderTrigger(frame !== null, pressed)}
      </Pressable>
      {layer ? null : (
        <Modal transparent visible={frame !== null} animationType="fade" onRequestClose={close}>
          {panel}
        </Modal>
      )}
    </>
  );
}

export function MenuItem({
  theme,
  title,
  onPress,
  selected,
  destructive,
  color,
  disabled,
}: {
  theme: Theme;
  title: string;
  onPress(): void;
  selected?: boolean;
  destructive?: boolean;
  color?: string;
  disabled?: boolean;
}) {
  const c = theme.colors;
  return (
    <Pressable
      accessibilityRole="menuitem"
      accessibilityState={{ selected: !!selected, disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [
        { flexDirection: "row", alignItems: "center", gap: 10, marginHorizontal: 5, paddingVertical: 7, paddingHorizontal: 9, borderRadius: 7 },
        CLICKABLE,
        pressed || hovered ? { backgroundColor: c.surface2 } : null,
        disabled ? { opacity: 0.4 } : null,
      ]}
    >
      <Text numberOfLines={1} style={{ flex: 1, color: destructive ? c.statusDanger : (color ?? c.foreground), fontSize: 13, fontWeight: selected ? "600" : "400" }}>
        {title}
      </Text>
      <View style={{ width: 14, alignItems: "center" }}>{selected ? <Check color={c.foreground} /> : null}</View>
    </Pressable>
  );
}

export function MenuSeparator({ theme }: { theme: Theme }) {
  return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: theme.colors.border, marginVertical: 5, marginHorizontal: 10 }} />;
}

export function MenuSearch({ theme, value, onChange, placeholder = "Search" }: { theme: Theme; value: string; onChange(text: string): void; placeholder?: string }) {
  const c = theme.colors;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginHorizontal: 6, marginTop: 1, marginBottom: 5, paddingHorizontal: 9, borderRadius: 8, backgroundColor: c.surface2 }}>
      <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>⌕</Text>
      <TextInput
        autoFocus
        accessibilityLabel={placeholder}
        autoCapitalize="none"
        autoCorrect={false}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={c.foregroundMuted}
        style={{ flex: 1, paddingVertical: 6, color: c.foreground, fontSize: 13, outlineStyle: "none" } as unknown as TextStyle}
      />
    </View>
  );
}
