import type { Project } from "../types";

export function hasFocusedProjects(projects: Project[]): boolean {
  return projects.some((project) => project.focused);
}

export function getFocusedProjects(projects: Project[]): Project[] {
  return projects.filter((project) => project.focused);
}
