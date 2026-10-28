// Shared frame bootstrap: connect, theme every `ready`, mount once.
import { connectHost, type HostClient, type HostReadyContext } from "@openchamber/sdk";
import { applyHostReady } from "@openchamber/sdk/ui";
import { installStyle } from "./style.ts";
import type { ServiceCall } from "./feed.ts";

export type Host = HostClient;

export function boot(mount: (host: Host, ctx: HostReadyContext, root: HTMLElement) => void): Host {
  const host = connectHost();
  installStyle();
  const root = document.getElementById("root") ?? document.body.appendChild(document.createElement("div"));
  let mounted = false;
  host.onReady((ctx) => {
    applyHostReady(ctx, document.documentElement);
    if (mounted) return;
    mounted = true;
    mount(host, ctx, root);
  });
  return host;
}

export function serviceCall(host: Host): ServiceCall {
  return (request) => host.serviceRequest(request);
}

export function openUrl(host: Host, url: string | null | undefined): void {
  if (url) void host.openUrl(url).catch(() => undefined);
}
