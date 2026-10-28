// Tiny DOM helpers and inline icons. The page sandbox loads nothing from outside the package.

type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: { class?: string; title?: string; style?: string; onClick?: (event: MouseEvent) => void } | null = null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props?.class) node.className = props.class;
  if (props?.title) node.title = props.title;
  if (props?.style) node.setAttribute("style", props.style);
  if (props?.onClick) {
    const handler = props.onClick;
    node.addEventListener("click", (event) => {
      event.preventDefault();
      handler(event as MouseEvent);
    });
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

const PATHS = {
  check: '<path d="M20 6 9 17l-5-5"/>',
  checkCircle: '<circle cx="12" cy="12" r="9"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  xCircle: '<circle cx="12" cy="12" r="9"/><path d="m15 9-6 6M9 9l6 6"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  server: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  external: '<path d="M14 4h6v6"/><path d="M10 14 20 4"/><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/>',
  commit: '<circle cx="12" cy="12" r="3.5"/><path d="M3 12h5.5M15.5 12H21"/>',
  alert: '<path d="M12 3 2 20h20L12 3Z"/><path d="M12 10v4M12 17h.01"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.9-3.5L4 9"/><path d="M4 4v5h5"/><path d="M4 13a8 8 0 0 0 14.9 3.5L20 15"/><path d="M20 20v-5h-5"/>',
  arrow: '<path d="M7 17 17 7"/><path d="M8 7h9v9"/>',
  bot: '<rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 8V4M9 14h.01M15 14h.01"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 0 1 4.9.7c0 1.7-2.4 2.3-2.4 3.8M12 17h.01"/>',
  minus: '<circle cx="12" cy="12" r="9"/><path d="M8 12h8"/>',
} as const;

export type IconName = keyof typeof PATHS;

export function icon(name: IconName, size = 14, className = "", strokeWidth = 2): SVGSVGElement {
  const wrapper = document.createElement("span");
  wrapper.innerHTML = `<svg class="ic ${className}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name]}</svg>`;
  return wrapper.firstElementChild as SVGSVGElement;
}

/** The rotating ring of a running step. */
export function spinner(size = 14): SVGSVGElement {
  const wrapper = document.createElement("span");
  wrapper.innerHTML = `<svg class="ic spin" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5" stroke="color-mix(in srgb, currentColor 25%, transparent)"/><path d="M20.5 12a8.5 8.5 0 0 0-8.5-8.5" stroke="currentColor"/></svg>`;
  return wrapper.firstElementChild as SVGSVGElement;
}

/** Progress ring: `fraction` of the release pipeline done. */
export function ring(fraction: number, size = 16, tone = "run"): SVGSVGElement {
  const radius = 8.3;
  const circumference = 2 * Math.PI * radius;
  const filled = Math.max(0.04, Math.min(1, fraction)) * circumference;
  const wrapper = document.createElement("span");
  wrapper.innerHTML = `<svg class="ic ring t-${tone}" width="${size}" height="${size}" viewBox="0 0 24 24" style="transform:rotate(-90deg)" aria-hidden="true"><circle cx="12" cy="12" r="${radius}" fill="none" stroke="var(--rl-track)" stroke-width="3.6"/><circle cx="12" cy="12" r="${radius}" fill="none" stroke="currentColor" stroke-width="3.6" stroke-linecap="round" stroke-dasharray="${filled.toFixed(2)} ${circumference.toFixed(2)}"/></svg>`;
  return wrapper.firstElementChild as SVGSVGElement;
}

export function replaceChildren(node: Element, ...children: Child[]): void {
  node.replaceChildren(...children.filter((child): child is Node | string => child !== null && child !== undefined && child !== false));
}
