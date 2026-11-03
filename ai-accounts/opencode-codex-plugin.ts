import type { Hooks } from "@opencode-ai/plugin";

/** Retained references must block fresh OpenAI processes until the paused handoff removes them. */
export default async function retiredOpenAIBroker(): Promise<Hooks> {
  const rejectOpenAI = async (input: { model: { providerID: string } }) => {
    if (input.model.providerID === "openai") {
      throw new Error("OpenAI native handoff pending: the legacy ai-accounts Codex entry is still loaded. Keep OpenCode launches paused, obtain permission to drain and fully retire old broker processes (including idle servers), then complete native OpenAI login. While still paused, reload the ai-accounts Paseo plugin to remove owned shim/manual config references and verify migration readiness. Only then launch a fresh stock OpenCode process. Do not restart Paseo. Anthropic is unaffected.");
    }
  };
  return { "chat.params": rejectOpenAI, "chat.headers": rejectOpenAI };
}
