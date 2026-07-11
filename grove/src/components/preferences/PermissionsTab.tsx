import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, Loader2, RefreshCw, ShieldCheck } from "lucide-react";
import { cn } from "../../lib/cn";
import {
  getCommandErrorMessage,
  getDevPermissionsStatus,
  requestDevPermission,
} from "../../lib/platform";
import type { DevPermissionId, DevPermissionState, DevPermissionStatus } from "../../types";
import { useToastStore } from "../../store/toast";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import {
  DEV_PERMISSION_ROWS,
  devPermissionStatusBadgeVariant,
  devPermissionStatusLabel,
} from "./dev-permission-rows";

export default function PermissionsTab() {
  const addToast = useToastStore((s) => s.addToast);
  const [states, setStates] = useState<DevPermissionState[]>([]);
  const [loading, setLoading] = useState(true);
  const [pendingId, setPendingId] = useState<DevPermissionId | null>(null);
  const mountedRef = useRef(true);
  const refreshSequenceRef = useRef(0);

  const statusById = useMemo(
    () => new Map<DevPermissionId, DevPermissionStatus>(states.map((s) => [s.id, s.status])),
    [states],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      refreshSequenceRef.current += 1;
    };
  }, []);

  const refresh = useCallback(async () => {
    const refreshId = refreshSequenceRef.current + 1;
    refreshSequenceRef.current = refreshId;
    setLoading(true);
    try {
      const next = await getDevPermissionsStatus();
      if (mountedRef.current && refreshId === refreshSequenceRef.current) {
        setStates(next);
      }
    } catch (error) {
      if (mountedRef.current && refreshId === refreshSequenceRef.current) {
        addToast("error", `Could not load permissions: ${getCommandErrorMessage(error)}`);
      }
    } finally {
      if (mountedRef.current && refreshId === refreshSequenceRef.current) {
        setLoading(false);
      }
    }
  }, [addToast]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Why: after the user flips a toggle in System Settings and switches back to
  // Grove, the chips should reflect the new status without a manual Refresh
  // click. Tied to window focus rather than a polling interval so we don't keep
  // querying macOS TCC while the pane is idle.
  useEffect(() => {
    const onFocus = () => {
      void refresh();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  const request = async (id: DevPermissionId) => {
    setPendingId(id);
    try {
      const result = await requestDevPermission(id);
      if (!mountedRef.current) {
        return;
      }
      await refresh();
      if (!mountedRef.current) {
        return;
      }
      if (result.status === "granted") {
        addToast("success", "Permission granted");
      } else if (result.openedSystemSettings) {
        addToast("info", "Opened macOS Privacy & Security");
      } else {
        addToast("info", "Permission request sent");
      }
    } catch (error) {
      if (mountedRef.current) {
        addToast("error", getCommandErrorMessage(error));
      }
    } finally {
      if (mountedRef.current) {
        setPendingId(null);
      }
    }
  };

  return (
    <div>
      <h3 className={cn("text-sm font-semibold text-foreground mb-6")}>Permissions</h3>

      <div
        className={cn(
          "flex items-start justify-between gap-4 rounded-md border border-border bg-secondary/20 px-4 py-3 mb-5",
        )}
      >
        <div className={cn("min-w-0")}>
          <div className={cn("flex items-center gap-2 text-[12px] font-medium text-foreground")}>
            <ShieldCheck className={cn("size-4")} />
            Terminal tools inherit Grove's macOS privacy envelope.
          </div>
          <p className={cn("mt-1 text-[11px] text-muted-foreground/70")}>
            Grant access here so CLIs, local apps, and automation tools launched from Grove
            terminals don't hit repeated macOS prompts. Grove does not ask at startup.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={cn("shrink-0")}
          disabled={loading}
          onClick={() => void refresh()}
        >
          <RefreshCw className={cn("size-3.5", { "animate-spin": loading })} />
          Refresh
        </Button>
      </div>

      <div className={cn("divide-y divide-border rounded-md border border-border")}>
        {DEV_PERMISSION_ROWS.map((row) => {
          const status = statusById.get(row.id);
          const pending = pendingId === row.id;
          const unsupported = status === "unsupported";
          const Icon = row.icon;

          return (
            <div key={row.id} className={cn("flex items-center justify-between gap-4 px-4 py-3")}>
              <div className={cn("flex min-w-0 items-start gap-3")}>
                <Icon className={cn("mt-0.5 size-4 shrink-0 text-muted-foreground")} />
                <div className={cn("min-w-0")}>
                  <div className={cn("flex flex-wrap items-center gap-2")}>
                    <span className={cn("text-[13px] font-medium text-foreground")}>
                      {row.label}
                    </span>
                    <Badge variant={devPermissionStatusBadgeVariant(status)}>
                      {devPermissionStatusLabel(status)}
                    </Badge>
                  </div>
                  <p className={cn("mt-1 text-[11px] text-muted-foreground/70")}>
                    {row.description}
                  </p>
                </div>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className={cn("shrink-0")}
                disabled={pending || unsupported}
                onClick={() => void request(row.id)}
              >
                {pending ? (
                  <Loader2 className={cn("animate-spin")} />
                ) : (
                  <ExternalLink className={cn("size-3.5")} />
                )}
                {row.actionLabel}
              </Button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
