import { ChevronRight } from "lucide-react";
import type React from "react";
import { Card, Chip } from "@gascity/ui";
import {
  categoryForPack,
  latestActiveRelease,
  type CatalogPack,
} from "../lib/registry";
import { buildSearchString, packPath, type SearchState } from "../lib/urlState";
import { PackIcon, shortSource, StatusBadge } from "./RegistryPrimitives";

type PackLinkProps = {
  pack: CatalogPack;
  searchState: SearchState;
  view: "card" | "list";
  onNavigate: (name: string) => void;
};

export function PackLink({ pack, searchState, view, onNavigate }: PackLinkProps) {
  const latest = latestActiveRelease(pack);
  const category = categoryForPack(pack);
  const href = `${packPath(pack.name)}${buildSearchString(searchState)}`;
  const navigate = (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    event.preventDefault();
    onNavigate(pack.name);
  };

  if (view === "card") {
    return (
      <a className="packCard" href={href} onClick={navigate}>
        <Card variant="surface" interactive className="packCardInner">
          <div className="packCardHeader">
            <PackIcon pack={pack} />
            <StatusBadge pack={pack} />
          </div>
          <h3>{pack.name}</h3>
          <p>{pack.description}</p>
          <div className="packMeta">
            <Chip mono={false}>{category.label}</Chip>
            <Chip>{latest ? `v${latest.version}` : "No active release"}</Chip>
            <Chip>{pack.releases.length} releases</Chip>
          </div>
        </Card>
      </a>
    );
  }

  return (
    <a className="packListItem" href={href} onClick={navigate}>
      <PackIcon pack={pack} />
      <span className="packListBody">
        <span className="packListTitle">
          <strong>{pack.name}</strong>
          <StatusBadge pack={pack} />
        </span>
        <span>{pack.description}</span>
        <span className="packMeta">
          <Chip mono={false}>{category.label}</Chip>
          <Chip>{latest ? `v${latest.version}` : "No active release"}</Chip>
          <Chip>{shortSource(pack.source)}</Chip>
        </span>
      </span>
      <ChevronRight size={18} aria-hidden="true" />
    </a>
  );
}
