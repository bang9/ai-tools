import type { CSSProperties } from "react";
import { arrayMove } from "@dnd-kit/sortable";
import {
  BookOpen,
  Bot,
  Box,
  Bug,
  Code2,
  Flame,
  Folder,
  Gem,
  type LucideIcon,
  Palette,
  Rocket,
  Sprout,
  Star,
  Terminal,
  Briefcase,
  Database,
  Wrench,
} from "lucide-react";
import type {
  ProjectCategory,
  ProjectCategoryIcon,
  ProjectCategoryIconId,
} from "../types";
import { cn } from "./cn";

export const DEFAULT_PROJECT_CATEGORY_ID = "default";

type ProjectCategoryIconOption = {
  id: ProjectCategoryIconId;
  label: string;
  icon: LucideIcon;
};

type ProjectCategoryEmojiOption = {
  value: string;
  label: string;
};

export const PROJECT_CATEGORY_ICON_OPTIONS: ProjectCategoryIconOption[] = [
  { id: "sprout", label: "Sprout", icon: Sprout },
  { id: "folder", label: "Folder", icon: Folder },
  { id: "rocket", label: "Rocket", icon: Rocket },
  { id: "flame", label: "Flame", icon: Flame },
  { id: "bug", label: "Bug", icon: Bug },
  { id: "wrench", label: "Wrench", icon: Wrench },
  { id: "book", label: "Book", icon: BookOpen },
  { id: "palette", label: "Palette", icon: Palette },
  { id: "database", label: "Database", icon: Database },
  { id: "bot", label: "Bot", icon: Bot },
  { id: "terminal", label: "Terminal", icon: Terminal },
  { id: "briefcase", label: "Briefcase", icon: Briefcase },
  { id: "star", label: "Star", icon: Star },
  { id: "package", label: "Package", icon: Box },
  { id: "code", label: "Code", icon: Code2 },
  { id: "gem", label: "Gem", icon: Gem },
];

export const PROJECT_CATEGORY_EMOJI_OPTIONS: ProjectCategoryEmojiOption[] = [
  { value: "🌱", label: "Sprout" },
  { value: "📁", label: "Folder" },
  { value: "🚀", label: "Rocket" },
  { value: "🔥", label: "Fire" },
  { value: "🐞", label: "Bug" },
  { value: "🛠️", label: "Tools" },
  { value: "📚", label: "Books" },
  { value: "🎨", label: "Palette" },
  { value: "🗄️", label: "Database" },
  { value: "🤖", label: "Robot" },
  { value: "💻", label: "Terminal" },
  { value: "💼", label: "Briefcase" },
  { value: "⭐", label: "Star" },
  { value: "📦", label: "Package" },
  { value: "🧩", label: "Code" },
  { value: "💎", label: "Gem" },
];

const PROJECT_CATEGORY_ICON_MAP = new Map(
  PROJECT_CATEGORY_ICON_OPTIONS.map((option) => [option.id, option.icon]),
);

export const DEFAULT_PROJECT_CATEGORY: ProjectCategory = {
  id: DEFAULT_PROJECT_CATEGORY_ID,
  name: "Default",
  color: "#6b7280",
  icon: { type: "lucide", value: "sprout" },
};

export const FOCUSING_PROJECT_CATEGORY_ID = "__focusing__";

export const FOCUSING_PROJECT_CATEGORY: ProjectCategory = {
  id: FOCUSING_PROJECT_CATEGORY_ID,
  name: "Focusing",
  color: "#f59e0b",
  icon: { type: "lucide", value: "star" },
};

export function getProjectCategories(
  projectCategories: ProjectCategory[],
): ProjectCategory[] {
  return [DEFAULT_PROJECT_CATEGORY, ...projectCategories];
}

export function reorderProjectCategories(
  categories: ProjectCategory[],
  activeId: string,
  overId: string,
): ProjectCategory[] {
  const oldIndex = categories.findIndex((category) => category.id === activeId);
  const newIndex = categories.findIndex((category) => category.id === overId);
  if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) {
    return categories;
  }
  return arrayMove(categories, oldIndex, newIndex);
}

export function resolveProjectCategory(
  categoryId: string | null | undefined,
  projectCategories: ProjectCategory[],
): ProjectCategory {
  const allCategories = getProjectCategories(projectCategories);
  return (
    allCategories.find((category) => category.id === categoryId) ??
    DEFAULT_PROJECT_CATEGORY
  );
}

export function resolveProjectCategoryId(
  categoryId: string | null | undefined,
): string {
  return categoryId ?? DEFAULT_PROJECT_CATEGORY_ID;
}

export function sanitizeProjectCategoryName(name: string): string {
  return Array.from(name.trim()).slice(0, 10).join("");
}

export function sanitizeProjectCategoryEmoji(value: string): string {
  return Array.from(value.trim()).slice(0, 4).join("");
}

export function getProjectCategoryEmojiOptions(selectedEmoji?: string) {
  const normalizedSelected = selectedEmoji
    ? sanitizeProjectCategoryEmoji(selectedEmoji)
    : "";
  if (!normalizedSelected) {
    return PROJECT_CATEGORY_EMOJI_OPTIONS;
  }

  if (
    PROJECT_CATEGORY_EMOJI_OPTIONS.some(
      (option) => option.value === normalizedSelected,
    )
  ) {
    return PROJECT_CATEGORY_EMOJI_OPTIONS;
  }

  return [
    {
      value: normalizedSelected,
      label: "Current",
    },
    ...PROJECT_CATEGORY_EMOJI_OPTIONS.slice(
      0,
      Math.max(PROJECT_CATEGORY_ICON_OPTIONS.length - 1, 0),
    ),
  ];
}

export function buildProjectCategoryId(
  name: string,
  existingIds: Iterable<string>,
): string {
  const base =
    sanitizeProjectCategoryName(name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "category";
  const seen = new Set(existingIds);
  let candidate = base;
  let suffix = 2;
  while (candidate === DEFAULT_PROJECT_CATEGORY_ID || seen.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function generateRandomProjectCategoryColor(): string {
  return `#${Math.floor(Math.random() * 0xffffff)
    .toString(16)
    .padStart(6, "0")}`;
}

export function getRandomProjectCategoryColor(
  existingColors: string[],
  excludedColors: string[] = [],
): string {
  const blocked = new Set([...existingColors, ...excludedColors]);
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const color = generateRandomProjectCategoryColor();
    if (!blocked.has(color)) {
      return color;
    }
  }

  return generateRandomProjectCategoryColor();
}

function hexToRgb(hex: string): [number, number, number] {
  const normalized = hex.replace("#", "");
  const chunk =
    normalized.length === 3
      ? normalized
          .split("")
          .map((char) => char + char)
          .join("")
      : normalized;
  return [
    Number.parseInt(chunk.slice(0, 2), 16),
    Number.parseInt(chunk.slice(2, 4), 16),
    Number.parseInt(chunk.slice(4, 6), 16),
  ];
}

export function colorWithAlpha(hex: string, alpha: number): string {
  const [red, green, blue] = hexToRgb(hex);
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

export function getProjectCategoryBadgeStyle(color: string): CSSProperties {
  return {
    borderColor: colorWithAlpha(color, 0.28),
    backgroundColor: colorWithAlpha(color, 0.14),
    color,
  };
}

export function getProjectCategoryButtonStyle(color: string): CSSProperties {
  return {
    borderColor: colorWithAlpha(color, 0.2),
    backgroundColor: colorWithAlpha(color, 0.12),
    color,
  };
}

export function ProjectCategoryIconGlyph({
  icon,
  className,
}: {
  icon: ProjectCategoryIcon;
  className?: string;
}) {
  if (icon.type === "emoji") {
    return (
      <span className={cn("inline-flex items-center justify-center", className)}>
        {icon.value}
      </span>
    );
  }

  const LucideIcon = PROJECT_CATEGORY_ICON_MAP.get(icon.value) ?? Sprout;
  return <LucideIcon className={cn(className)} />;
}
