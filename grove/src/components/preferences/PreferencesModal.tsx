import { Dialog, DialogContent, DialogTitle, DialogDescription } from "../ui/dialog";
import { cn } from "../../lib/cn";
import GeneralTab from "./GeneralTab";
import CategoriesTab from "./CategoriesTab";
import TerminalTab from "./TerminalTab";
import BrowserTab from "./BrowserTab";
import DeveloperTab from "./DeveloperTab";
import PermissionsTab from "./PermissionsTab";
import type { PreferencesTabId } from "../../store/preferences-ui";

const TABS: { id: PreferencesTabId; label: string }[] = [
  { id: "general", label: "General" },
  { id: "categories", label: "Categories" },
  { id: "terminal", label: "Terminal" },
  { id: "browser", label: "Browser" },
  { id: "developer", label: "Developer" },
  { id: "permissions", label: "Permissions" },
];

interface Props {
  open: boolean;
  onClose: () => void;
  activeTab: PreferencesTabId;
  onTabChange: (tab: PreferencesTabId) => void;
}

export default function PreferencesModal({ open, onClose, activeTab, onTabChange }: Props) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className={cn("gap-0 p-0 sm:max-w-4xl overflow-hidden")} showCloseButton>
        <DialogTitle className={cn("sr-only")}>Preferences</DialogTitle>
        <DialogDescription className={cn("sr-only")}>Application preferences</DialogDescription>
        <div className={cn("flex h-[720px]")}>
          {/* Left: Tab Navigation */}
          <nav
            className={cn(
              "flex w-[160px] shrink-0 flex-col gap-0.5 border-r border-border bg-secondary/30 p-2 pt-3",
            )}
          >
            {TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => onTabChange(tab.id)}
                className={cn("rounded-md px-3 py-1.5 text-left text-[13px] transition-colors", {
                  "bg-accent/15 font-medium text-foreground": activeTab === tab.id,
                  "text-muted-foreground hover:bg-accent/8 hover:text-foreground":
                    activeTab !== tab.id,
                })}
              >
                {tab.label}
              </button>
            ))}
          </nav>

          {/* Right: Content */}
          <div className={cn("flex-1 overflow-y-auto p-6")}>
            {activeTab === "general" && <GeneralTab />}
            {activeTab === "categories" && <CategoriesTab />}
            {activeTab === "terminal" && <TerminalTab />}
            {activeTab === "browser" && <BrowserTab />}
            {activeTab === "developer" && <DeveloperTab />}
            {activeTab === "permissions" && <PermissionsTab />}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
