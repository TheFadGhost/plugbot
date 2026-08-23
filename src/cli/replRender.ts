import type { MockDelivery } from "../adapter/mock.js";
import { applyTheme, type ThemeName } from "../logging/themes.js";

export const PROMPT = "you> ";

export interface DeliveryRenderOptions {
  theme: ThemeName;
  color: boolean;
}

function ref(text: string, opts: DeliveryRenderOptions): string {
  return applyTheme("fgRef", text, opts.color, opts.theme);
}

export function renderDelivery(delivery: MockDelivery, opts: DeliveryRenderOptions): string[] {
  switch (delivery.kind) {
    case "send": {
      const channel = ref(`[#${delivery.channelId}]`, opts);
      const name = ref("plugbot", opts);
      const threadSuffix = delivery.threadId !== undefined ? " (thread)" : "";
      return [`${channel} ${name}: ${delivery.text}${threadSuffix}`];
    }
    case "edit":
      return [`edited ${ref(`[#${delivery.channelId}]`, opts)} ${delivery.messageId}: ${delivery.text}`];
    case "delete":
      return [`deleted ${ref(`[#${delivery.channelId}]`, opts)} ${delivery.messageId}`];
    case "react":
      return [`reacted ${ref(`[#${delivery.channelId}]`, opts)} :${delivery.emoji}:`];
    default:
      return [];
  }
}

export function renderSystemNotice(text: string): string {
  return `note: ${text}`;
}
