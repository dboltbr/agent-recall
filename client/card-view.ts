// What a release timeline card draws, decided from its data alone: nothing (folded into a newer
// card), the group line of superseded releases, or one release, open while the run is live and a
// one-line summary once it ends.
import type { ReleaseCard } from "../shared/release-cards.ts";
import { isActive, type Release } from "../shared/release-status.ts";

export type CardView = { readonly kind: "hidden" } | { readonly kind: "group"; readonly releases: readonly Release[] } | { readonly kind: "release" };

export function cardView(card: ReleaseCard): CardView {
  if (card.foldedInto !== undefined) return { kind: "hidden" };
  // Oldest first, like the timeline around it; the card's own release is the newest.
  if (card.folded?.length) return { kind: "group", releases: [...card.folded, card.release] };
  return { kind: "release" };
}

/** Open until the user chooses: live runs expanded, finished ones (any verdict) collapsed. */
export function releaseOpen(release: Release, choice: boolean | null): boolean {
  return choice ?? isActive(release);
}
