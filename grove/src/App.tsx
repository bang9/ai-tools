import { useEffect } from "react";
import Layout from "./Layout";
import { ToastContainer } from "./components/ui/toast";
import { OverlayContainer } from "./lib/overlay";
import { initBackendLogPipe } from "./lib/logger";
import { initUrlOpenPipe } from "./lib/url-open";
import { usePreventNativeBehaviors } from "./hooks/usePreventNativeBehaviors";
import { checkForUpdates } from "./lib/updater";
import { usePreferencesStore } from "./store/preferences";
import { useToastStore } from "./store/toast";
import { useNoteStore } from "./store/note";

function App() {
  usePreventNativeBehaviors();

  useEffect(() => {
    let cancelled = false;
    let cleanup: (() => void) | undefined;
    initBackendLogPipe().then((fn) => {
      if (cancelled) {
        fn?.();
      } else {
        cleanup = fn;
      }
    });
    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let cleanup: (() => void) | undefined;
    initUrlOpenPipe().then((fn) => {
      if (cancelled) {
        fn?.();
      } else {
        cleanup = fn;
      }
    });
    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, []);

  useEffect(() => {
    usePreferencesStore.getState().init();
  }, []);
  useEffect(() => {
    useNoteStore.getState().init();
  }, []);

  useEffect(() => {
    checkForUpdates((version) => {
      useToastStore
        .getState()
        .addToast("info", `Update available: v${version}. Restart the app to update.`);
    });
  }, []);

  return (
    <>
      <Layout />
      <OverlayContainer />
      <ToastContainer />
    </>
  );
}

export default App;
