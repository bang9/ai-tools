import { useState } from "react";
import { useMissionStore } from "../../store/mission";
import { useToast } from "../../store/toast";
import { getCommandErrorMessage } from "../../lib/platform";
import { Input } from "../ui/input";
import { Button } from "../ui/button";
import { cn } from "../../lib/cn";
import { sanitizeBranchName } from "../../lib/git-utils";

interface Props {
  onClose: () => void;
}

function CreateMissionDialog({ onClose }: Props) {
  const [name, setName] = useState("");
  const [branchName, setBranchName] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const createMission = useMissionStore((s) => s.createMission);
  const { toast } = useToast();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    const trimmedBranchName = branchName.trim();

    setError("");
    setLoading(true);
    try {
      await createMission(trimmed, trimmedBranchName || null);
      toast("success", "Mission created");
      onClose();
    } catch (err) {
      setError(getCommandErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={cn("px-3 py-3 border-b border-[var(--color-border)]")}>
      <form onSubmit={handleSubmit}>
        <Input
          type="text"
          placeholder="Mission name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
          disabled={loading}
          className="mb-2"
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
          }}
        />
        <Input
          type="text"
          placeholder="Branch name (optional)"
          value={branchName}
          onChange={(e) => setBranchName(sanitizeBranchName(e.target.value))}
          disabled={loading}
          className="mb-2"
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
          }}
        />
        {error && (
          <div
            className={cn("text-[11px] text-[var(--color-danger)] mb-2 break-all leading-relaxed")}
          >
            {error}
          </div>
        )}
        <div className={cn("flex gap-2 justify-end")}>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onClose}
            disabled={loading}
            className="text-[var(--color-text-secondary)]"
          >
            Cancel
          </Button>
          <Button
            type="submit"
            variant="default"
            size="sm"
            disabled={loading || !name.trim()}
            className={cn({ "animate-pulse-subtle": loading })}
          >
            {loading ? "Creating..." : "Create"}
          </Button>
        </div>
      </form>
    </div>
  );
}

export default CreateMissionDialog;
