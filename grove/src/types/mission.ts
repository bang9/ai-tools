export interface MissionProject {
  projectId: string;
  branch: string;
  path: string;
}

export interface Mission {
  id: string;
  name: string;
  branchName?: string;
  projects: MissionProject[];
  missionDir: string;
  collapsed: boolean;
}
