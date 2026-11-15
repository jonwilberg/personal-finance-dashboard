import { useEffect, useState } from "react";
import { api, type VersionInfo } from "./api";
import { formatUpdated } from "./format";

const REPO = "jonwilberg/personal-finance-dashboard";

type Latest = { state: "same" } | { state: "newer"; sha: string } | { state: "unknown" };

/**
 * Which version is running and when it was deployed, and whether it's the latest main. The latest main comes from
 * GitHub's public API, asked by the browser (the repository is public, so no token is involved). A newer main is
 * normally on its way: CI builds it and the server picks it up within minutes.
 */
export function VersionFooter() {
  const [version, setVersion] = useState<VersionInfo | null>(null);
  const [latest, setLatest] = useState<Latest | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .version()
      .then(async (info) => {
        if (cancelled) return;
        setVersion(info);
        if (!info.revision) return;
        try {
          const response = await fetch(`https://api.github.com/repos/${REPO}/commits/main`, {
            headers: { Accept: "application/vnd.github+json" },
          });
          if (!response.ok) throw new Error(String(response.status));
          const sha: string = (await response.json()).sha;
          if (!cancelled) setLatest(sha === info.revision ? { state: "same" } : { state: "newer", sha });
        } catch {
          if (!cancelled) setLatest({ state: "unknown" });
        }
      })
      .catch(() => undefined); // the footer is optional; the page's own errors are shown elsewhere
    return () => {
      cancelled = true;
    };
  }, []);

  if (!version) return null;
  if (!version.revision) {
    return <footer className="version-footer meta small">Local build</footer>;
  }
  const short = version.revision.slice(0, 7);
  return (
    <footer className="version-footer meta small">
      Version{" "}
      <a href={`https://github.com/${REPO}/commit/${version.revision}`} target="_blank" rel="noreferrer">
        {short}
      </a>{" "}
      · deployed {formatUpdated(version.started_at)}
      {latest?.state === "same" && <span className="version-current"> · up to date</span>}
      {latest?.state === "newer" && (
        <span className="version-behind">
          {" "}
          · newer version{" "}
          <a href={`https://github.com/${REPO}/commit/${latest.sha}`} target="_blank" rel="noreferrer">
            {latest.sha.slice(0, 7)}
          </a>{" "}
          on its way
        </span>
      )}
    </footer>
  );
}
