import { OpenAIAuthPlugin } from "opencode-openai-codex-auth";
import { wrapAuthPlugin } from "./opencode-auth-wrapper";

export default wrapAuthPlugin(OpenAIAuthPlugin, "openai");
