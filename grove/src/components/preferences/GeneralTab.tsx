import type { ReactNode } from "react";
import { ArrowDown, ArrowUp, FolderOpen, GitBranch, Plus, Terminal, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { usePreferencesStore } from "../../store/preferences";
import { cn } from "../../lib/cn";
import type { ProjectViewMode } from "../../types";
import { Button, IconButton } from "../ui/button";
import {
  GIT_GUI_REGISTRY,
  buildGitGuiMenuItem,
  getGitGuiMenuItemDisplayName,
  getGitGuiRegistryEntry,
} from "../../lib/git-gui-registry";
import {
  IDE_REGISTRY,
  buildIdeMenuItem,
  getIdeMenuItemDisplayName,
  getIdeRegistryEntry,
} from "../../lib/ide-registry";
import IdeAppIcon from "../ide/IdeAppIcon";

const PROJECT_VIEW_MODE_OPTIONS: { id: ProjectViewMode; label: string }[] = [
  { id: "default", label: "Default" },
  { id: "group-by-orgs", label: "Group by orgs" },
];

interface MenuRegistryEntry {
  id: string;
  displayName: string;
  iconSrc?: string;
}

interface MenuItemLike {
  id: string;
  displayName?: string;
  openCommand?: string;
}

interface PreviewRow {
  label: string;
  icon: ReactNode;
  badge?: string;
}

interface MenuItemsSectionProps<T extends MenuItemLike> {
  title: string;
  description: ReactNode;
  previewDescription: string;
  availableTitle: string;
  availableDescription: string;
  emptyMessage: string;
  menuItems: T[];
  onMenuItemsChange: (items: T[]) => void;
  registry: readonly MenuRegistryEntry[];
  buildMenuItem: (id: string) => T | null;
  getEntry: (id: string) => MenuRegistryEntry | undefined;
  getDisplayName: (item: T) => string;
  previewRows: PreviewRow[];
  fallbackIcon?: LucideIcon;
  showPreview?: boolean;
}

function MenuPreviewRow({
  label,
  icon,
  badge,
  actions,
}: {
  label: string;
  icon: ReactNode;
  badge?: string;
  actions?: ReactNode;
}) {
  return (
    <div
      className={cn("flex h-7 items-center gap-2 rounded-sm px-1.5 text-[11px] text-foreground")}
    >
      {icon}
      <div className={cn("min-w-0 flex flex-1 items-center gap-2")}>
        <div className={cn("truncate font-medium")} title={label}>
          {label}
        </div>
        {badge && (
          <span
            className={cn(
              "shrink-0 rounded-full border border-border/70 bg-secondary/40 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground",
            )}
          >
            {badge}
          </span>
        )}
      </div>
      {actions && <div className={cn("flex items-center gap-1")}>{actions}</div>}
    </div>
  );
}

function moveMenuItems<T>(items: T[], index: number, offset: -1 | 1): T[] {
  const nextIndex = index + offset;
  if (nextIndex < 0 || nextIndex >= items.length) {
    return items;
  }

  const nextItems = [...items];
  const [moved] = nextItems.splice(index, 1);
  nextItems.splice(nextIndex, 0, moved);
  return nextItems;
}

function MenuItemsSection<T extends MenuItemLike>({
  title,
  description,
  previewDescription,
  availableTitle,
  availableDescription,
  emptyMessage,
  menuItems,
  onMenuItemsChange,
  registry,
  buildMenuItem,
  getEntry,
  getDisplayName,
  previewRows,
  fallbackIcon,
  showPreview = true,
}: MenuItemsSectionProps<T>) {
  const selectedIds = new Set(menuItems.map((item) => item.id));
  const availableEntries = registry.filter((entry) => !selectedIds.has(entry.id));

  const addMenuItem = (id: string) => {
    const item = buildMenuItem(id);
    if (!item) {
      return;
    }

    onMenuItemsChange([...menuItems, item]);
  };

  const removeMenuItem = (id: string) => {
    onMenuItemsChange(menuItems.filter((item) => item.id !== id));
  };

  const moveMenuItem = (index: number, offset: -1 | 1) => {
    onMenuItemsChange(moveMenuItems(menuItems, index, offset));
  };

  return (
    <div>
      <h4 className={cn("mb-1 text-[12px] font-medium text-foreground")}>{title}</h4>
      <p className={cn("mb-4 text-[11px] text-muted-foreground/70")}>{description}</p>

      <div className={cn("space-y-5")}>
        {showPreview && (
          <div className={cn("w-full max-w-[380px] space-y-3")}>
            <div>
              <h5
                className={cn(
                  "text-[11px] font-medium uppercase tracking-wider text-muted-foreground",
                )}
              >
                Menu Preview
              </h5>
              <p className={cn("mt-1 text-[11px] text-muted-foreground/70")}>
                {previewDescription}
              </p>
            </div>
            <div className={cn("mt-2.5 h-[134px]")}>
              <div
                className={cn(
                  "max-h-full overflow-hidden rounded-md border border-border bg-background p-1 shadow-sm",
                )}
              >
                <div className={cn("menu-preview-scroll max-h-[126px] overflow-y-auto")}>
                  {previewRows.map((row, index) => (
                    <MenuPreviewRow
                      key={`${row.label}-${index}`}
                      label={row.label}
                      icon={row.icon}
                      badge={row.badge}
                    />
                  ))}
                  {menuItems.map((item, index) => {
                    const entry = getEntry(item.id);
                    const label = getDisplayName(item);
                    return (
                      <MenuPreviewRow
                        key={item.id}
                        label={`Open in ${label}`}
                        badge={item.openCommand ? "Custom" : undefined}
                        icon={
                          <IdeAppIcon
                            iconSrc={entry?.iconSrc}
                            label={label}
                            className={cn("size-3.5")}
                            fallbackIcon={fallbackIcon}
                          />
                        }
                        actions={
                          <>
                            <IconButton
                              type="button"
                              className={cn("h-6 w-6")}
                              onClick={() => moveMenuItem(index, -1)}
                              disabled={index === 0}
                              aria-label={`Move ${label} up`}
                            >
                              <ArrowUp className={cn("size-3.5")} />
                            </IconButton>
                            <IconButton
                              type="button"
                              className={cn("h-6 w-6")}
                              onClick={() => moveMenuItem(index, 1)}
                              disabled={index === menuItems.length - 1}
                              aria-label={`Move ${label} down`}
                            >
                              <ArrowDown className={cn("size-3.5")} />
                            </IconButton>
                          </>
                        }
                      />
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        )}

        <div className={cn("space-y-3")}>
          <div>
            <h5
              className={cn(
                "text-[11px] font-medium uppercase tracking-wider text-muted-foreground",
              )}
            >
              {availableTitle}
            </h5>
            <p className={cn("mt-1 text-[11px] text-muted-foreground/70")}>
              {availableDescription}
            </p>
          </div>
          <div className={cn("mt-2.5 grid gap-2 sm:grid-cols-2 lg:grid-cols-3")}>
            {registry.map((entry) => {
              const isSelected = selectedIds.has(entry.id);
              return (
                <div
                  key={entry.id}
                  className={cn(
                    "flex items-center gap-2.5 rounded-lg border border-border/70 bg-background px-2.5 py-2",
                  )}
                >
                  <IdeAppIcon
                    iconSrc={entry.iconSrc}
                    label={entry.displayName}
                    className={cn("size-8")}
                    fallbackIcon={fallbackIcon}
                  />
                  <div className={cn("min-w-0 flex-1")}>
                    <div
                      className={cn("truncate text-[12px] font-medium text-foreground")}
                      title={entry.displayName}
                    >
                      {entry.displayName}
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className={cn("shrink-0 border-0 shadow-none", {
                      "text-muted-foreground/35 hover:text-muted-foreground/70": isSelected,
                    })}
                    aria-label={
                      isSelected
                        ? `Remove ${entry.displayName} from menu`
                        : `Add ${entry.displayName} to menu`
                    }
                    title={isSelected ? `Remove ${entry.displayName}` : `Add ${entry.displayName}`}
                    onClick={() => (isSelected ? removeMenuItem(entry.id) : addMenuItem(entry.id))}
                  >
                    {isSelected ? (
                      <X className={cn("size-3.5")} />
                    ) : (
                      <Plus className={cn("size-3.5")} />
                    )}
                  </Button>
                </div>
              );
            })}
          </div>
          {availableEntries.length === 0 && (
            <p className={cn("mt-2.5 text-[11px] text-muted-foreground/70")}>{emptyMessage}</p>
          )}
        </div>
      </div>
    </div>
  );
}

export default function GeneralTab() {
  const projectViewMode = usePreferencesStore((s) => s.projectViewMode);
  const setProjectViewMode = usePreferencesStore((s) => s.setProjectViewMode);
  const ideMenuItems = usePreferencesStore((s) => s.ideMenuItems);
  const setIdeMenuItems = usePreferencesStore((s) => s.setIdeMenuItems);
  const gitGuiMenuItems = usePreferencesStore((s) => s.gitGuiMenuItems);
  const setGitGuiMenuItems = usePreferencesStore((s) => s.setGitGuiMenuItems);

  const basePreviewRows: PreviewRow[] = [
    {
      label: "Open in Finder",
      icon: <FolderOpen className={cn("size-3.5 shrink-0 text-muted-foreground")} />,
    },
    {
      label: "Open in Global Terminal",
      icon: <Terminal className={cn("size-3.5 shrink-0 text-muted-foreground")} />,
    },
  ];

  return (
    <div>
      <h3 className={cn("mb-5 text-sm font-semibold text-foreground")}>General</h3>

      <div className={cn("mb-6")}>
        <h4 className={cn("mb-1 text-[12px] font-medium text-foreground")}>Project view mode</h4>
        <p className={cn("mb-2 text-[11px] text-muted-foreground/70")}>
          Controls how projects are organized in the sidebar
        </p>
        <select
          value={projectViewMode}
          onChange={(e) => setProjectViewMode(e.target.value as ProjectViewMode)}
          className={cn(
            "w-[240px] rounded-md border border-border bg-background px-3 py-1.5 text-[12px] text-foreground",
            "focus:outline-none focus:border-ring transition-colors",
          )}
        >
          {PROJECT_VIEW_MODE_OPTIONS.map((opt) => (
            <option key={opt.id} value={opt.id}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      <div className={cn("border-t border-border mb-6")} />

      <MenuItemsSection
        title="IDE menu items"
        description={
          <>
            Choose which IDEs appear in sidebar context menus. Order here becomes `Finder` → `Global
            Terminal` → your selected IDEs.
          </>
        }
        previewDescription="Reorder selected IDE items here."
        availableTitle="Available IDEs"
        availableDescription="Add or remove the editors surfaced in the sidebar context menu."
        emptyMessage="All supported IDEs are already shown in the menu."
        menuItems={ideMenuItems}
        onMenuItemsChange={setIdeMenuItems}
        registry={IDE_REGISTRY}
        buildMenuItem={buildIdeMenuItem}
        getEntry={getIdeRegistryEntry}
        getDisplayName={getIdeMenuItemDisplayName}
        previewRows={basePreviewRows}
      />

      <div className={cn("border-t border-border my-6")} />

      <MenuItemsSection
        title="Git GUI menu items"
        description={
          <>
            Choose which Git GUIs appear in sidebar context menus after the IDE section. Order here
            becomes `Finder` → `Global Terminal` → your selected IDEs → your selected Git GUIs.
          </>
        }
        previewDescription="Reorder selected Git GUI items here."
        availableTitle="Available Git GUIs"
        availableDescription="Add or remove the Git GUIs surfaced in the sidebar context menu."
        emptyMessage="All supported Git GUIs are already shown in the menu."
        menuItems={gitGuiMenuItems}
        onMenuItemsChange={setGitGuiMenuItems}
        registry={GIT_GUI_REGISTRY}
        buildMenuItem={buildGitGuiMenuItem}
        getEntry={getGitGuiRegistryEntry}
        getDisplayName={getGitGuiMenuItemDisplayName}
        previewRows={[]}
        fallbackIcon={GitBranch}
        showPreview={false}
      />
    </div>
  );
}
