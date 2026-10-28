import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const pinSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  title: z.string(),
  body: z.string(),
  url: z.string().nullable(),
  faviconUrl: z.string().nullable(),
  createdAt: z.string(),
});

export type Pin = z.infer<typeof pinSchema>;

export const listPinsRpc = defineRpc({
  name: "pins.list",
  input: z.object({}),
  output: z.object({ pins: z.array(pinSchema) }),
});

export const savePinRpc = defineRpc({
  name: "pins.save",
  input: z.object({
    agentId: z.string().min(1),
    title: z.string(),
    body: z.string().min(1),
  }),
  output: pinSchema,
});

export const removePinRpc = defineRpc({
  name: "pins.remove",
  input: z.object({ id: z.string().min(1) }),
  output: z.object({ removed: z.boolean() }),
});
