import type { PluginClientContext } from "@getpaseo/plugin/client";
import { installSelectionQuote } from "./client/web";

export default function contribute(_client: PluginClientContext) {
  return installSelectionQuote();
}
