import { AnthropicAuthPlugin } from "@ex-machina/opencode-anthropic-auth";
import { wrapAuthPlugin } from "./opencode-auth-wrapper";

export default wrapAuthPlugin(AnthropicAuthPlugin, "anthropic");
