import { useEffect, useMemo, useState } from "react";
import { Check, Pencil, Plus, Trash2 } from "lucide-react";
import type {
  ProjectCategory,
  ProjectCategoryIcon,
  ProjectCategoryIconId,
} from "../../types";
import { usePreferencesStore } from "../../store/preferences";
import { useProjectStore } from "../../store/project";
import { getCommandErrorMessage } from "../../lib/platform";
import {
  buildProjectCategoryId,
  colorWithAlpha,
  DEFAULT_PROJECT_CATEGORY,
  DEFAULT_PROJECT_CATEGORY_ID,
  getProjectCategoryEmojiOptions,
  getProjectCategories,
  getProjectCategoryBadgeStyle,
  getProjectCategoryButtonStyle,
  getRandomProjectCategoryColor,
  ProjectCategoryIconGlyph,
  PROJECT_CATEGORY_EMOJI_OPTIONS,
  PROJECT_CATEGORY_ICON_OPTIONS,
  sanitizeProjectCategoryEmoji,
  sanitizeProjectCategoryName,
} from "../../lib/project-categories";
import { overlay } from "../../lib/overlay";
import { cn } from "../../lib/cn";
import { Button, IconButton } from "../ui/button";
import { Input } from "../ui/input";

type DraftState = {
  id: string | null;
  name: string;
  iconMode: ProjectCategoryIcon["type"];
  emoji: string;
  lucideIconId: ProjectCategoryIconId;
};

function makeDefaultDraft(): DraftState {
  return {
    id: null,
    name: "",
    iconMode: "emoji",
    emoji: PROJECT_CATEGORY_EMOJI_OPTIONS[0]?.value ?? "🌱",
    lucideIconId: "sprout",
  };
}

function ProjectCategoryBadge({ category }: { category: ProjectCategory }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-[11px] font-medium",
      )}
      style={getProjectCategoryBadgeStyle(category.color)}
    >
      <ProjectCategoryIconGlyph icon={category.icon} className={cn("size-3.5")} />
      <span>{category.name}</span>
    </span>
  );
}

interface Props {
  projectId?: string;
  managementMode?: "full" | "assign-only";
}

export default function ProjectCategoriesPanel({
  projectId,
  managementMode = "full",
}: Props) {
  const projectCategories = usePreferencesStore((state) => state.projectCategories);
  const setProjectCategories = usePreferencesStore((state) => state.setProjectCategories);
  const deleteProjectCategory = usePreferencesStore(
    (state) => state.deleteProjectCategory,
  );
  const projects = useProjectStore((state) => state.projects);
  const setProjectCategory = useProjectStore((state) => state.setProjectCategory);

  const [draft, setDraft] = useState<DraftState>(makeDefaultDraft);
  const [submitting, setSubmitting] = useState(false);
  const [assigningCategoryId, setAssigningCategoryId] = useState<string | null>(null);
  const [deletingCategoryId, setDeletingCategoryId] = useState<string | null>(null);
  const [randomizingCategoryId, setRandomizingCategoryId] = useState<string | null>(null);
  const [error, setError] = useState("");

  const project = projectId
    ? projects.find((item) => item.id === projectId) ?? null
    : null;
  const categories = getProjectCategories(projectCategories);
  const selectedCategoryId = project?.categoryId ?? DEFAULT_PROJECT_CATEGORY_ID;
  const showManagementControls = managementMode === "full";
  const editing = draft.id != null;
  const sanitizedName = sanitizeProjectCategoryName(draft.name);
  const sanitizedEmoji = sanitizeProjectCategoryEmoji(draft.emoji);
  const emojiOptions = useMemo(
    () => getProjectCategoryEmojiOptions(draft.emoji),
    [draft.emoji],
  );
  const canSubmit =
    sanitizedName.length > 0 &&
    (draft.iconMode === "lucide" || sanitizedEmoji.length > 0);

  useEffect(() => {
    if (!draft.id) {
      return;
    }

    const category = projectCategories.find((item) => item.id === draft.id);
    if (!category) {
      setDraft(makeDefaultDraft());
    }
  }, [draft.id, projectCategories]);

  const resetDraft = () => {
    setDraft(makeDefaultDraft());
    setError("");
  };

  const startEditing = (category: ProjectCategory) => {
    if (category.id === DEFAULT_PROJECT_CATEGORY_ID) {
      return;
    }

    setDraft({
      id: category.id,
      name: category.name,
      iconMode: category.icon.type,
      emoji:
        category.icon.type === "emoji"
          ? category.icon.value
          : (PROJECT_CATEGORY_EMOJI_OPTIONS[0]?.value ?? "🌱"),
      lucideIconId:
        category.icon.type === "lucide" ? category.icon.value : "sprout",
    });
    setError("");
  };

  const handleSubmit = async () => {
    if (!canSubmit) {
      return;
    }

    const icon: ProjectCategoryIcon =
      draft.iconMode === "emoji"
        ? { type: "emoji", value: sanitizedEmoji }
        : { type: "lucide", value: draft.lucideIconId };

    const nextCategory: ProjectCategory = draft.id
      ? {
          id: draft.id,
          name: sanitizedName,
          color:
            projectCategories.find((category) => category.id === draft.id)?.color ??
            getRandomProjectCategoryColor(projectCategories.map((category) => category.color)),
          icon,
        }
      : {
          id: buildProjectCategoryId(
            sanitizedName,
            categories.map((category) => category.id),
          ),
          name: sanitizedName,
          color: getRandomProjectCategoryColor(
            projectCategories.map((category) => category.color),
          ),
          icon,
        };

    const nextCategories = draft.id
      ? projectCategories.map((category) =>
          category.id === draft.id ? nextCategory : category,
        )
      : [...projectCategories, nextCategory];

    setSubmitting(true);
    setError("");
    try {
      await setProjectCategories(nextCategories);
      resetDraft();
    } catch (err) {
      setError(getCommandErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleAssign = async (categoryId: string) => {
    if (!project || categoryId === selectedCategoryId) {
      return;
    }

    setAssigningCategoryId(categoryId);
    setError("");
    try {
      await setProjectCategory(project.id, categoryId);
    } catch (err) {
      setError(getCommandErrorMessage(err));
    } finally {
      setAssigningCategoryId(null);
    }
  };

  const handleDelete = async (category: ProjectCategory) => {
    if (category.id === DEFAULT_PROJECT_CATEGORY_ID) {
      return;
    }

    const confirmed = await overlay.confirm({
      title: "Delete category?",
      description: (
        <>
          <p>
            Projects in{" "}
            <span className={cn("font-semibold text-foreground")}>
              {category.name}
            </span>{" "}
            will move to Default.
          </p>
        </>
      ),
      confirmLabel: "Delete category",
      variant: "destructive",
    });
    if (!confirmed) {
      return;
    }

    setDeletingCategoryId(category.id);
    setError("");
    try {
      await deleteProjectCategory(category.id);
      if (draft.id === category.id) {
        resetDraft();
      }
    } catch (err) {
      setError(getCommandErrorMessage(err));
    } finally {
      setDeletingCategoryId(null);
    }
  };

  const handleRandomizeColor = async (category: ProjectCategory) => {
    if (
      category.id === DEFAULT_PROJECT_CATEGORY_ID ||
      randomizingCategoryId === category.id
    ) {
      return;
    }

    const nextColor = getRandomProjectCategoryColor(
      projectCategories
        .filter((item) => item.id !== category.id)
        .map((item) => item.color),
      [category.color],
    );
    const nextCategories = projectCategories.map((item) =>
      item.id === category.id ? { ...item, color: nextColor } : item,
    );

    setRandomizingCategoryId(category.id);
    setError("");
    try {
      await setProjectCategories(nextCategories);
    } catch (err) {
      setError(getCommandErrorMessage(err));
    } finally {
      setRandomizingCategoryId(null);
    }
  };

  return (
    <div className={cn("space-y-6")}>
      {project && (
        <div className={cn("rounded-xl border border-border bg-secondary/20 p-4")}>
          <p className={cn("text-[11px] font-medium uppercase tracking-wider text-muted-foreground")}>
            Project Category
          </p>
          <div className={cn("mt-2 flex items-center gap-2")}>
            <span className={cn("truncate text-sm font-medium text-foreground")}>
              {project.name}
            </span>
            <ProjectCategoryBadge
              category={
                categories.find((category) => category.id === selectedCategoryId) ??
                DEFAULT_PROJECT_CATEGORY
              }
            />
          </div>
          <p className={cn("mt-2 text-[12px] leading-relaxed text-muted-foreground")}>
            Click a category below to reassign this project.
          </p>
        </div>
      )}

      <div className={cn("space-y-3")}>
        <div>
          <h4 className={cn("text-[12px] font-medium text-foreground")}>Categories</h4>
          <p className={cn("mt-1 text-[11px] text-muted-foreground/70")}>
            {showManagementControls
              ? "Default is fixed. Added categories appear in the sidebar filter row."
              : "Select a category to reassign this project."}
          </p>
        </div>

        <div
          className={cn(
            "space-y-2 overflow-y-auto pr-1",
            {
              "max-h-[22rem]": showManagementControls,
              "max-h-[26rem]": !showManagementControls,
            },
          )}
        >
          {categories.map((category) => {
            const selected = category.id === selectedCategoryId;
            const deleting = deletingCategoryId === category.id;
            const assigning = assigningCategoryId === category.id;
            const randomizing = randomizingCategoryId === category.id;
            const canRandomizeColor =
              showManagementControls && category.id !== DEFAULT_PROJECT_CATEGORY_ID;
            const selectedStyle =
              selected && managementMode === "assign-only" && project
                ? { borderColor: colorWithAlpha(category.color, 0.5) }
                : undefined;

            return (
              <div
                key={category.id}
                className={cn(
                  "flex items-center gap-2 rounded-xl border border-border/80 bg-background/80 p-2.5",
                )}
                style={selectedStyle}
              >
                {showManagementControls && (
                  canRandomizeColor ? (
                    <button
                      type="button"
                      className={cn(
                        "shrink-0 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
                        {
                          "cursor-pointer": !randomizing,
                          "cursor-wait": randomizing,
                        },
                      )}
                      onClick={() => {
                        void handleRandomizeColor(category);
                      }}
                      title={`Randomize ${category.name} color`}
                      disabled={submitting || deleting || randomizing}
                    >
                      <span
                        className={cn(
                          "inline-flex size-8 items-center justify-center rounded-full border transition-transform hover:scale-[1.03]",
                        )}
                        style={getProjectCategoryButtonStyle(category.color)}
                      >
                        <ProjectCategoryIconGlyph
                          icon={category.icon}
                          className={cn("size-4")}
                        />
                      </span>
                    </button>
                  ) : (
                    <span
                      className={cn(
                        "inline-flex size-8 shrink-0 items-center justify-center rounded-full border",
                      )}
                      style={getProjectCategoryButtonStyle(category.color)}
                    >
                      <ProjectCategoryIconGlyph
                        icon={category.icon}
                        className={cn("size-4")}
                      />
                    </span>
                  )
                )}
                <button
                  type="button"
                  className={cn(
                    "flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors",
                    {
                      "cursor-pointer hover:bg-secondary/40": !!project,
                      "cursor-default": !project,
                    },
                  )}
                  onClick={() => {
                    if (project) {
                      void handleAssign(category.id);
                    }
                  }}
                  disabled={assigning || deleting || !project}
                >
                  {!showManagementControls && (
                    <span
                      className={cn(
                        "inline-flex size-8 shrink-0 items-center justify-center rounded-full border",
                      )}
                      style={getProjectCategoryButtonStyle(category.color)}
                    >
                      <ProjectCategoryIconGlyph
                        icon={category.icon}
                        className={cn("size-4")}
                      />
                    </span>
                  )}
                  <div className={cn("min-w-0 flex-1")}>
                    <div className={cn("flex items-center gap-2")}>
                      <span className={cn("truncate text-sm font-medium text-foreground")}>
                        {category.name}
                      </span>
                      {category.id === DEFAULT_PROJECT_CATEGORY_ID && (
                        <span
                          className={cn(
                            "rounded-full border border-border/70 bg-secondary/40 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground",
                          )}
                        >
                          System
                        </span>
                      )}
                    </div>
                    {selected && project && showManagementControls && (
                      <div
                        className={cn(
                          "mt-1 flex items-center gap-2 text-[11px] text-muted-foreground",
                        )}
                      >
                        <span
                          className={cn("inline-flex items-center gap-1 text-foreground")}
                        >
                          <Check className={cn("size-3")} />
                          Assigned
                        </span>
                      </div>
                    )}
                  </div>
                </button>

                {showManagementControls &&
                  category.id !== DEFAULT_PROJECT_CATEGORY_ID && (
                  <div className={cn("flex shrink-0 items-center gap-1")}>
                    <IconButton
                      type="button"
                      className={cn("h-7 w-7")}
                      onClick={() => startEditing(category)}
                      title={`Edit ${category.name}`}
                      disabled={submitting || deleting}
                    >
                      <Pencil className={cn("size-3.5")} />
                    </IconButton>
                    <IconButton
                      type="button"
                      className={cn("h-7 w-7")}
                      onClick={() => {
                        void handleDelete(category);
                      }}
                      title={`Delete ${category.name}`}
                      disabled={submitting || deleting}
                    >
                      <Trash2 className={cn("size-3.5")} />
                    </IconButton>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {showManagementControls && (
        <div className={cn("rounded-xl border border-border bg-background/70 p-4")}>
        <div className={cn("flex items-center justify-between gap-3")}>
          <div>
            <h4 className={cn("text-[12px] font-medium text-foreground")}>
              {editing ? "Edit category" : "Add category"}
            </h4>
            <p className={cn("mt-1 text-[11px] text-muted-foreground/70")}>
              Names are limited to 10 characters.
            </p>
          </div>
          {editing && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={(event) => {
                event.currentTarget.blur();
                resetDraft();
              }}
              disabled={submitting}
            >
              Cancel edit
            </Button>
          )}
        </div>

        <div className={cn("mt-4 space-y-4")}>
          <div className={cn("space-y-2")}>
            <label className={cn("text-[11px] font-medium uppercase tracking-wider text-muted-foreground")}>
              Name
            </label>
            <Input
              className={cn("placeholder:text-muted-foreground/45")}
              value={draft.name}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  name: sanitizeProjectCategoryName(event.target.value),
                }))
              }
              placeholder="Frontend"
              maxLength={10}
            />
          </div>

          <div className={cn("space-y-2")}>
            <label className={cn("text-[11px] font-medium uppercase tracking-wider text-muted-foreground")}>
              Icon Type
            </label>
            <div className={cn("grid grid-cols-2 gap-2")}>
              <Button
                type="button"
                variant={draft.iconMode === "emoji" ? "default" : "outline"}
                size="sm"
                onClick={() =>
                  setDraft((current) => ({ ...current, iconMode: "emoji" }))
                }
              >
                Emoji
              </Button>
              <Button
                type="button"
                variant={draft.iconMode === "lucide" ? "default" : "outline"}
                size="sm"
                onClick={() =>
                  setDraft((current) => ({ ...current, iconMode: "lucide" }))
                }
              >
                Icon
              </Button>
            </div>
          </div>

          {draft.iconMode === "emoji" ? (
            <div className={cn("space-y-2")}>
              <label className={cn("text-[11px] font-medium uppercase tracking-wider text-muted-foreground")}>
                Emoji
              </label>
              <div className={cn("grid w-full grid-cols-4 gap-1.5")}>
                {emojiOptions.map((option) => {
                  const selected = sanitizedEmoji === option.value;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      className={cn(
                        "flex h-8 w-full items-center justify-center rounded-lg border text-base transition-colors",
                        {
                          "border-accent bg-accent/12 text-foreground": selected,
                          "border-border bg-background text-muted-foreground hover:bg-secondary/40 hover:text-foreground":
                            !selected,
                        },
                      )}
                      title={option.label}
                      onClick={() =>
                        setDraft((current) => ({
                          ...current,
                          emoji: option.value,
                        }))
                      }
                    >
                      <span>{option.value}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className={cn("space-y-2")}>
              <label className={cn("text-[11px] font-medium uppercase tracking-wider text-muted-foreground")}>
                Icon
              </label>
              <div className={cn("grid w-full grid-cols-4 gap-1.5")}>
                {PROJECT_CATEGORY_ICON_OPTIONS.map((option) => {
                  const selected = draft.lucideIconId === option.id;
                  const OptionIcon = option.icon;
                  return (
                    <button
                      key={option.id}
                      type="button"
                      className={cn(
                        "flex h-8 w-full items-center justify-center rounded-lg border transition-colors",
                        {
                          "border-accent bg-accent/12 text-foreground": selected,
                          "border-border bg-background text-muted-foreground hover:bg-secondary/40 hover:text-foreground":
                            !selected,
                        },
                      )}
                      title={option.label}
                      onClick={() =>
                        setDraft((current) => ({
                          ...current,
                          lucideIconId: option.id,
                        }))
                      }
                    >
                      <OptionIcon className={cn("size-3.5")} />
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <div className={cn("rounded-lg border border-border/70 bg-secondary/20 p-3")}>
            <p className={cn("text-[11px] font-medium uppercase tracking-wider text-muted-foreground")}>
              Preview
            </p>
            <div className={cn("mt-2")}>
              <ProjectCategoryBadge
                category={{
                  id: draft.id ?? "preview",
                  name: sanitizedName || "Category",
                  color:
                    projectCategories.find((category) => category.id === draft.id)?.color ??
                    DEFAULT_PROJECT_CATEGORY.color,
                  icon:
                    draft.iconMode === "emoji"
                      ? {
                          type: "emoji",
                          value:
                            sanitizedEmoji ||
                            (PROJECT_CATEGORY_EMOJI_OPTIONS[0]?.value ?? "🌱"),
                        }
                      : { type: "lucide", value: draft.lucideIconId },
                }}
              />
            </div>
          </div>

          {error && (
            <p className={cn("text-[12px] text-destructive")}>{error}</p>
          )}

          <div className={cn("flex justify-end")}>
            {editing ? (
              <Button
                key="update-category"
                type="button"
                className={cn("min-w-[148px] transition-colors")}
                onClick={() => {
                  void handleSubmit();
                }}
                disabled={!canSubmit || submitting}
              >
                <Check className={cn("size-4")} />
                Update category
              </Button>
            ) : (
              <Button
                key="add-category"
                type="button"
                className={cn("min-w-[148px] transition-colors")}
                onClick={() => {
                  void handleSubmit();
                }}
                disabled={!canSubmit || submitting}
              >
                <Plus className={cn("size-4")} />
                Add category
              </Button>
            )}
          </div>
        </div>
        </div>
      )}
    </div>
  );
}
