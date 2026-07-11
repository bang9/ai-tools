import { useEffect, useState } from "react";

// The app expresses dark mode via a `.dark` class on a root element (see the
// `@custom-variant dark (&:is(.dark *))` rule in App.css). Read it and watch
// for changes so syntax highlighting can pick the matching shiki theme.
function readIsDark(): boolean {
  if (typeof document === "undefined") return false;
  return (
    document.documentElement.classList.contains("dark") || document.body.classList.contains("dark")
  );
}

export function useIsDarkTheme(): boolean {
  const [isDark, setIsDark] = useState(readIsDark);

  useEffect(() => {
    const update = () => setIsDark(readIsDark());
    update();
    const observer = new MutationObserver(update);
    const options: MutationObserverInit = { attributes: true, attributeFilter: ["class"] };
    observer.observe(document.documentElement, options);
    observer.observe(document.body, options);
    return () => observer.disconnect();
  }, []);

  return isDark;
}
